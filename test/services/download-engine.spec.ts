import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';

import { Logger } from '@nestjs/common';

import { DownloadServerTopic } from '@/gateways/protocols/download/topics';
import { PluginRegistry } from '@/plugins/plugin-registry';
import { DownloadingInfos, DownloadStatus } from '@/schemas/DownloadItem';
import { DownloadEngine } from '@/services/download-engine';
import { DownloadEventEmitter } from '@/services/download-events';
import { StateStore } from '@/services/state-store';

Logger.overrideLogger(false);

type InjectedItem = {
  item: { url: string; metadata?: Record<string, string> };
  infos: DownloadingInfos;
  stream?: PassThrough;
  filePath: string;
  speedSamples: never[];
  restartAttempts: number;
};

function buildInfos(id: string, status: DownloadStatus, metadata?: Record<string, string>): DownloadingInfos {
  return {
    id,
    status,
    fileName: `${id}.mkv`,
    filePaths: [],
    size: null,
    downloaded: 0,
    progress: null,
    speed: 0,
    eta: null,
    error: null,
    source: 'test',
    metadata,
    createdAt: new Date(0),
    downloadedAt: null,
    completedAt: null,
  };
}

function buildHarness() {
  const events = new DownloadEventEmitter();
  const stateStore = { setSource: jest.fn(), scheduleFlush: jest.fn() };
  const registry = { findHostFor: jest.fn().mockReturnValue(undefined) };
  const downloadsPath = fs.mkdtempSync(path.join(os.tmpdir(), 'fetchr-engine-'));
  const engine = new DownloadEngine(
    registry as unknown as PluginRegistry,
    events,
    stateStore as unknown as StateStore,
    downloadsPath,
    1,
  );

  const inject = (id: string, status: DownloadStatus, extra: Partial<InjectedItem> = {}): InjectedItem => {
    const injected: InjectedItem = {
      item: { url: `https://host.test/${id}`, metadata: extra.infos?.metadata },
      infos: buildInfos(id, status, extra.infos?.metadata),
      filePath: '',
      speedSamples: [],
      restartAttempts: 0,
      ...extra,
    };
    (engine as unknown as { items: InjectedItem[] }).items.push(injected);
    return injected;
  };

  const emitted = <T extends DownloadServerTopic>(topic: T): jest.Mock => {
    const listener = jest.fn();
    events.on(topic, listener);
    return listener;
  };

  return { engine, stateStore, downloadsPath, inject, emitted };
}

describe('DownloadEngine registry', () => {
  it('lists nothing until a download is registered', () => {
    const { engine } = buildHarness();

    expect(engine.list()).toEqual([]);
    expect(engine.get('missing')).toBeUndefined();
  });

  it('exposes every item and finds one by id', () => {
    const { engine, inject } = buildHarness();
    inject('a', DownloadStatus.Downloading);
    inject('b', DownloadStatus.Completed);

    expect(engine.list().map((i) => i.id)).toEqual(['a', 'b']);
    expect(engine.get('b')?.status).toBe(DownloadStatus.Completed);
  });

  describe('remove', () => {
    it('drops the item, broadcasts its metadata one last time and persists', () => {
      const { engine, inject, emitted, stateStore } = buildHarness();
      inject('a', DownloadStatus.Completed, { infos: buildInfos('a', DownloadStatus.Completed, { imdbid: 'tt1' }) });
      const removed = emitted(DownloadServerTopic.Removed);

      engine.remove('a');

      expect(engine.list()).toEqual([]);
      expect(removed).toHaveBeenCalledWith({ id: 'a', metadata: { imdbid: 'tt1' } });
      expect(stateStore.scheduleFlush).toHaveBeenCalled();
    });

    it('ignores unknown ids', () => {
      const { engine, emitted } = buildHarness();
      const removed = emitted(DownloadServerTopic.Removed);

      engine.remove('missing');

      expect(removed).not.toHaveBeenCalled();
    });
  });

  describe('clearCompleted', () => {
    it('removes completed and failed items, keeps the rest', () => {
      const { engine, inject, emitted } = buildHarness();
      inject('done', DownloadStatus.Completed);
      inject('broken', DownloadStatus.Failed);
      inject('running', DownloadStatus.Downloading);
      const removed = emitted(DownloadServerTopic.Removed);

      expect(engine.clearCompleted()).toBe(2);

      expect(engine.list().map((i) => i.id)).toEqual(['running']);
      expect(removed).toHaveBeenCalledTimes(2);
    });

    it('does not persist when nothing was cleared', () => {
      const { engine, inject, stateStore } = buildHarness();
      inject('running', DownloadStatus.Downloading);

      expect(engine.clearCompleted()).toBe(0);
      expect(stateStore.scheduleFlush).not.toHaveBeenCalled();
    });
  });

  describe('cancel', () => {
    it('destroys the stream, deletes the partial file and broadcasts', () => {
      const { engine, inject, emitted, downloadsPath } = buildHarness();
      const filePath = path.join(downloadsPath, 'partial.mkv');
      fs.writeFileSync(filePath, 'partial');
      const stream = new PassThrough();
      const infos = buildInfos('a', DownloadStatus.Downloading, { 'crn-flix-request-id': 'r1' });
      inject('a', DownloadStatus.Downloading, { stream, filePath, infos });
      const canceled = emitted(DownloadServerTopic.Canceled);

      engine.cancel('a');

      expect(engine.list()).toEqual([]);
      expect(stream.destroyed).toBe(true);
      expect(fs.existsSync(filePath)).toBe(false);
      expect(canceled).toHaveBeenCalledWith({ id: 'a', metadata: { 'crn-flix-request-id': 'r1' } });
    });

    it('leaves completed downloads alone', () => {
      const { engine, inject, emitted } = buildHarness();
      inject('a', DownloadStatus.Completed);
      const canceled = emitted(DownloadServerTopic.Canceled);

      engine.cancel('a');

      expect(engine.list()).toHaveLength(1);
      expect(canceled).not.toHaveBeenCalled();
    });
  });

  describe('download', () => {
    it('returns the existing item instead of registering the same url twice', async () => {
      const { engine, inject, emitted } = buildHarness();
      const existing = inject('a', DownloadStatus.Downloading);
      const registered = emitted(DownloadServerTopic.Registered);

      const result = await engine.download({ url: existing.item.url });

      expect(result).toBe(existing.infos);
      expect(engine.list()).toHaveLength(1);
      expect(registered).not.toHaveBeenCalled();
    });

    it('lets a failed url be registered again', async () => {
      const { engine, inject } = buildHarness();
      const failed = inject('a', DownloadStatus.Failed);

      await expect(engine.download({ url: failed.item.url })).rejects.toThrow(/No plugin found/);
    });
  });

  describe('updateMetadata', () => {
    it('replaces the metadata of a running download and broadcasts it', () => {
      const { engine, inject, emitted, stateStore } = buildHarness();
      inject('a', DownloadStatus.Downloading, {
        infos: buildInfos('a', DownloadStatus.Downloading, { imdbid: 'tt1' }),
      });
      const updated = emitted(DownloadServerTopic.Updated);

      const result = engine.updateMetadata('a', { imdbid: 'tt2' });

      expect(result?.metadata).toEqual({ imdbid: 'tt2' });
      expect(engine.get('a')?.metadata).toEqual({ imdbid: 'tt2' });
      expect(updated).toHaveBeenCalledWith({ id: 'a', metadata: { imdbid: 'tt2' } });
      expect(stateStore.scheduleFlush).toHaveBeenCalled();
    });

    it('refuses once the download has completed', () => {
      const { engine, inject } = buildHarness();
      inject('a', DownloadStatus.Completed, { infos: buildInfos('a', DownloadStatus.Completed, { imdbid: 'tt1' }) });

      expect(engine.updateMetadata('a', { imdbid: 'tt2' })).toBeUndefined();
      expect(engine.get('a')?.metadata).toEqual({ imdbid: 'tt1' });
    });

    it('ignores unknown ids', () => {
      const { engine } = buildHarness();

      expect(engine.updateMetadata('missing', {})).toBeUndefined();
    });
  });
});
