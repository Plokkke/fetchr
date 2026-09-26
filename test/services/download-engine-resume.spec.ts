import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough, Readable } from 'node:stream';

import { Logger } from '@nestjs/common';

import { DownloadServerTopic } from '@/gateways/protocols/download/topics';
import { OpenedStream, OpenOptions } from '@/plugins/host-plugin';
import { PluginRegistry } from '@/plugins/plugin-registry';
import { DownloadStatus } from '@/schemas/DownloadItem';
import { DownloadEngine } from '@/services/download-engine';
import { DownloadEventEmitter } from '@/services/download-events';
import { OVERLAP_BYTES, partPathOf } from '@/services/resume';
import { PersistedItem, StateStore } from '@/services/state-store';

Logger.overrideLogger(false);
jest.setTimeout(5000);

const URL = 'https://host.test/movie';
const FILE_NAME = 'movie.mkv';

type HostBehaviour = { honourRange?: boolean; serve?: (from: number) => Buffer };

function buildHarness(content: Buffer, behaviour: HostBehaviour = {}, persisted: PersistedItem[] = []) {
  const events = new DownloadEventEmitter();
  const stateStore = {
    setSource: jest.fn(),
    scheduleFlush: jest.fn(),
    flushNow: jest.fn(),
    load: jest.fn().mockResolvedValue(persisted),
  };
  const open = jest.fn(async (options: OpenOptions): Promise<OpenedStream> => {
    const from = behaviour.honourRange === false ? 0 : options.from;
    const body = behaviour.serve ? behaviour.serve(from) : content.subarray(from);
    return { stream: Readable.from([body]), from, etag: '"etag-1"' };
  });
  const plugin = {
    name: 'fake',
    resolve: jest.fn(async () => ({ infos: { fileName: FILE_NAME, size: content.length, etag: '"etag-1"' }, open })),
  };
  const registry = { findHostFor: jest.fn().mockReturnValue(plugin), findArchiveFor: jest.fn() };
  const downloadsPath = fs.mkdtempSync(path.join(os.tmpdir(), 'fetchr-resume-'));
  const engine = new DownloadEngine(
    registry as unknown as PluginRegistry,
    events,
    stateStore as unknown as StateStore,
    downloadsPath,
    1,
  );
  const filePath = path.join(downloadsPath, FILE_NAME);
  const settled = new Promise<{ topic: DownloadServerTopic; payload: unknown }>((resolve) => {
    events.on(DownloadServerTopic.Completed, (payload) => resolve({ topic: DownloadServerTopic.Completed, payload }));
    events.on(DownloadServerTopic.Failed, (payload) => resolve({ topic: DownloadServerTopic.Failed, payload }));
  });
  const on = (topic: DownloadServerTopic) => {
    const listener = jest.fn();
    events.on(topic, listener);
    return listener;
  };

  return { engine, open, plugin, filePath, partPath: partPathOf(filePath), settled, on, stateStore, downloadsPath };
}

function randomBytes(length: number): Buffer {
  return crypto.randomBytes(length);
}

describe('DownloadEngine resume', () => {
  const content = randomBytes(OVERLAP_BYTES + 500_000);
  const partial = content.subarray(0, OVERLAP_BYTES + 200_000);
  const expectedFrom = partial.length - OVERLAP_BYTES;

  it('resumes from the partial file after verifying its last megabyte', async () => {
    const h = buildHarness(content);
    fs.writeFileSync(h.partPath, partial);

    await h.engine.download({ url: URL });
    const outcome = await h.settled;

    expect(outcome.topic).toBe(DownloadServerTopic.Completed);
    expect(h.open).toHaveBeenCalledWith({ from: expectedFrom, etag: '"etag-1"' });
    expect(fs.readFileSync(h.filePath).equals(content)).toBe(true);
    expect(fs.existsSync(h.partPath)).toBe(false);
    expect(h.engine.list()[0]).toMatchObject({ downloaded: content.length, progress: 1, etag: '"etag-1"' });
  });

  it('restarts from 0 when the host ignores the range', async () => {
    const h = buildHarness(content, { honourRange: false });
    fs.writeFileSync(h.partPath, partial);

    await h.engine.download({ url: URL });
    const outcome = await h.settled;

    expect(outcome.topic).toBe(DownloadServerTopic.Completed);
    expect(h.open).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(h.filePath).equals(content)).toBe(true);
  });

  it('discards a partial whose tail differs from the host and downloads it again', async () => {
    const h = buildHarness(content);
    const corrupted = Buffer.from(partial);
    corrupted[partial.length - 1000] ^= 0xff;
    fs.writeFileSync(h.partPath, corrupted);

    await h.engine.download({ url: URL });
    const outcome = await h.settled;

    expect(outcome.topic).toBe(DownloadServerTopic.Completed);
    expect(h.open.mock.calls.map(([o]) => o.from)).toEqual([expectedFrom, 0]);
    expect(fs.readFileSync(h.filePath).equals(content)).toBe(true);
  });

  it('verifies a leftover complete file against the host instead of downloading it again', async () => {
    const h = buildHarness(content);
    fs.writeFileSync(h.filePath, content);

    await h.engine.download({ url: URL });
    const outcome = await h.settled;

    expect(outcome.topic).toBe(DownloadServerTopic.Completed);
    expect(h.open).toHaveBeenCalledWith({ from: content.length - OVERLAP_BYTES, etag: '"etag-1"' });
    expect(fs.readFileSync(h.filePath).equals(content)).toBe(true);
  });

  it('fails and keeps the partial when the host sends fewer bytes than announced', async () => {
    const h = buildHarness(content, { serve: (from) => content.subarray(from, content.length - 10) });

    await h.engine.download({ url: URL });
    const outcome = await h.settled;

    expect(outcome.topic).toBe(DownloadServerTopic.Failed);
    expect(outcome.payload).toMatchObject({ error: expect.stringContaining('incomplete file') });
    expect(fs.existsSync(h.partPath)).toBe(true);
    expect(fs.existsSync(h.filePath)).toBe(false);
  });

  it('drops the partial when the resolved file is not the one it was taken from', async () => {
    const h = buildHarness(content);
    fs.writeFileSync(h.partPath, partial);
    const persisted = persistedDownloading(h.filePath, { etag: '"etag-0"', size: content.length });

    h.stateStore.load.mockResolvedValue([persisted]);
    await h.engine.onApplicationBootstrap();
    const outcome = await h.settled;

    expect(outcome.topic).toBe(DownloadServerTopic.Completed);
    expect(h.open).toHaveBeenCalledWith({ from: 0, etag: '"etag-1"' });
    expect(fs.readFileSync(h.filePath).equals(content)).toBe(true);
  });
});

function persistedDownloading(filePath: string, extra: Partial<PersistedItem['infos']> = {}): PersistedItem {
  return {
    item: { url: URL },
    filePath,
    restartAttempts: 0,
    infos: {
      id: 'restored',
      status: DownloadStatus.Downloading,
      fileName: FILE_NAME,
      filePaths: [],
      size: null,
      downloaded: 0,
      progress: null,
      speed: 0,
      eta: null,
      error: null,
      source: 'fake',
      createdAt: new Date(0).toISOString(),
      downloadedAt: null,
      completedAt: null,
      ...extra,
    },
  };
}

describe('DownloadEngine restart', () => {
  const content = randomBytes(2000);

  it('re-queues a download with its partial and resumes it after resolving again', async () => {
    const h = buildHarness(content);
    fs.writeFileSync(h.partPath, content.subarray(0, 800));

    h.stateStore.load.mockResolvedValue([persistedDownloading(h.filePath, { size: 2000, etag: '"etag-1"' })]);
    await h.engine.onApplicationBootstrap();

    expect(h.engine.get('restored')).toMatchObject({ downloaded: 800, progress: 0.4 });
    const outcome = await h.settled;
    expect(outcome.topic).toBe(DownloadServerTopic.Completed);
    expect(h.open).toHaveBeenCalledWith({ from: 0, etag: '"etag-1"' });
    expect(fs.readFileSync(h.filePath).equals(content)).toBe(true);
  });

  it('keeps a paused download paused and does not count the restart against it', async () => {
    const h = buildHarness(content);
    fs.writeFileSync(h.partPath, content.subarray(0, 800));
    const persisted = persistedDownloading(h.filePath, { status: DownloadStatus.Suspended, paused: true });
    persisted.restartAttempts = 2;

    h.stateStore.load.mockResolvedValue([persisted]);
    await h.engine.onApplicationBootstrap();
    await new Promise((resolve) => setImmediate(resolve));

    expect(h.engine.get('restored')).toMatchObject({ status: DownloadStatus.Suspended, paused: true });
    expect(h.open).not.toHaveBeenCalled();
    expect(fs.existsSync(h.partPath)).toBe(true);
  });

  it('marks a download failed after too many restarts and removes its files', async () => {
    const h = buildHarness(content);
    fs.writeFileSync(h.partPath, 'abc');
    const persisted = persistedDownloading(h.filePath);
    persisted.restartAttempts = 3;
    const failed = h.on(DownloadServerTopic.Failed);

    h.stateStore.load.mockResolvedValue([persisted]);
    await h.engine.onApplicationBootstrap();

    expect(h.engine.get('restored')).toMatchObject({
      status: DownloadStatus.Failed,
      error: expect.stringContaining('4'),
    });
    expect(failed).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(h.partPath)).toBe(false);
  });
});

describe('DownloadEngine suspend / resume', () => {
  it('pauses a running download, keeps its partial, and resumes it on demand', async () => {
    const content = randomBytes(3000);
    const live = new PassThrough();
    let firstOpen = true;
    const h = buildHarness(content);
    h.open.mockImplementation(async ({ from }) => {
      if (firstOpen) {
        firstOpen = false;
        return { stream: live, from: 0 };
      }
      return { stream: Readable.from([content.subarray(from)]), from };
    });
    const suspended = h.on(DownloadServerTopic.Suspended);
    const resumed = h.on(DownloadServerTopic.Resumed);

    const infos = await h.engine.download({ url: URL });
    await waitFor(() => h.open.mock.calls.length === 1);
    live.write(content.subarray(0, 1000));
    await waitFor(() => infos.downloaded === 1000);

    expect(h.engine.suspend(infos.id)).toMatchObject({ status: DownloadStatus.Suspended, paused: true });
    await waitFor(() => live.destroyed);
    expect(suspended).toHaveBeenCalledTimes(2);
    expect(h.engine.suspend(infos.id)).toBeUndefined();

    expect(h.engine.resume(infos.id)).toMatchObject({ paused: false });
    expect(resumed).toHaveBeenCalledWith(expect.objectContaining({ id: infos.id, fileName: FILE_NAME }));
    const outcome = await h.settled;

    expect(outcome.topic).toBe(DownloadServerTopic.Completed);
    expect(h.open).toHaveBeenCalledTimes(2);
    expect(fs.readFileSync(h.filePath).equals(content)).toBe(true);
  });

  it('parks a queued download until it is resumed', async () => {
    const h = buildHarness(randomBytes(10));
    const infos = await h.engine.download({ url: URL });

    expect(h.engine.suspend(infos.id)?.paused).toBe(true);
    await waitFor(() => infos.status === DownloadStatus.Suspended);
    await new Promise((resolve) => setImmediate(resolve));

    expect(h.open).not.toHaveBeenCalled();
    expect(h.engine.resume(infos.id)).toBeDefined();
    await h.settled;
    expect(h.open).toHaveBeenCalledTimes(1);
  });

  it('refuses to resume something that is not paused', () => {
    const h = buildHarness(randomBytes(10));

    expect(h.engine.resume('missing')).toBeUndefined();
  });

  it('does not report a cancelled download as failed', async () => {
    const live = new PassThrough();
    const h = buildHarness(randomBytes(10));
    h.open.mockResolvedValue({ stream: live, from: 0 });
    const failed = h.on(DownloadServerTopic.Failed);
    const canceled = h.on(DownloadServerTopic.Canceled);

    const infos = await h.engine.download({ url: URL });
    await waitFor(() => h.open.mock.calls.length === 1);
    h.engine.cancel(infos.id);
    await waitFor(() => live.destroyed);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(canceled).toHaveBeenCalledTimes(1);
    expect(failed).not.toHaveBeenCalled();
    expect(fs.existsSync(h.partPath)).toBe(false);
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('waitFor timed out');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
