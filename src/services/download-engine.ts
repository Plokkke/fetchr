import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { Readable, Transform } from 'stream';
import { pipeline } from 'stream/promises';

import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';

import { DownloadServerTopic } from '@/gateways/protocols/download/topics';
import { ArchivePlugin } from '@/plugins/archive-plugin';
import { FileInfo, HostPlugin, ResolvedSource } from '@/plugins/host-plugin';
import { PluginRegistry } from '@/plugins/plugin-registry';
import { DownloadingInfos, DownloadItem, DownloadStatus } from '@/schemas/DownloadItem';
import { DownloadEventEmitter } from '@/services/download-events';
import { RequestContext } from '@/services/request-context';
import { LiveItem, persistedToInfos, StateStore } from '@/services/state-store';
import { humanFileSize } from '@/utils';

const ACTIVE_DOWNLOAD_STATUSES = [DownloadStatus.Downloading, DownloadStatus.Extracting];
const RESUMABLE_STATUSES = [
  DownloadStatus.Resolving,
  DownloadStatus.Suspended,
  DownloadStatus.Downloading,
  DownloadStatus.Extracting,
];
const SPEED_WINDOW_MS = 5000;
const MAX_RESTART_ATTEMPTS = 3;

type SpeedSample = { timestamp: number; bytes: number };

type ActiveDownload = {
  item: DownloadItem;
  infos: DownloadingInfos;
  ctx?: RequestContext;
  resolved?: ResolvedSource;
  stream?: Readable;
  filePath: string;
  speedSamples: SpeedSample[];
  restartAttempts: number;
};

function computeSpeed(samples: SpeedSample[]): number {
  const now = Date.now();
  const recent = samples.filter((s) => now - s.timestamp < SPEED_WINDOW_MS);
  if (recent.length < 2) {
    return 0;
  }
  const totalBytes = recent.reduce((sum, s) => sum + s.bytes, 0);
  const elapsed = (now - recent[0].timestamp) / 1000;
  return elapsed > 0 ? totalBytes / elapsed : 0;
}

function computeEta(size: number | null, downloaded: number, speed: number): number | null {
  if (!size || speed <= 0) {
    return null;
  }
  return Math.round((size - downloaded) / speed);
}

@Injectable()
export class DownloadEngine implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(DownloadEngine.name);
  private items: ActiveDownload[] = [];
  private shuttingDown = false;

  constructor(
    private readonly registry: PluginRegistry,
    private readonly eventEmitter: DownloadEventEmitter,
    private readonly stateStore: StateStore,
    private readonly downloadsPath: string,
    private readonly maxConcurrent: number,
  ) {
    fs.mkdirSync(this.downloadsPath, { recursive: true });
    this.stateStore.setSource(() => this.snapshot());
  }

  async onApplicationBootstrap(): Promise<void> {
    const persisted = await this.stateStore.load();
    if (persisted.length === 0) {
      return;
    }

    for (const p of persisted) {
      const infos = persistedToInfos(p.infos);
      const restartAttempts = p.restartAttempts ?? 0;

      if (infos.status === DownloadStatus.Completed || infos.status === DownloadStatus.Failed) {
        this.items.push({
          item: { url: p.item.url, metadata: p.item.metadata } as DownloadItem,
          infos,
          filePath: p.filePath,
          speedSamples: [],
          restartAttempts,
        });
        continue;
      }

      const nextAttempts = restartAttempts + 1;
      if (nextAttempts > MAX_RESTART_ATTEMPTS) {
        this.logger.warn(
          `Item ${infos.id} (${infos.fileName || p.item.url}) exceeded ${MAX_RESTART_ATTEMPTS} restart-retries, marking failed`,
        );
        infos.status = DownloadStatus.Failed;
        infos.error = `too many restart-retries (${nextAttempts})`;
        infos.speed = 0;
        infos.eta = null;
        infos.progress = null;
        await this.cleanupArtifacts(p.filePath, infos.fileName);
        this.items.push({
          item: { url: p.item.url, metadata: p.item.metadata } as DownloadItem,
          infos,
          filePath: p.filePath,
          speedSamples: [],
          restartAttempts: nextAttempts,
        });
        this.eventEmitter.emit(DownloadServerTopic.Failed, {
          id: infos.id,
          fileName: infos.fileName,
          error: infos.error,
          source: infos.source,
        });
        continue;
      }

      await this.cleanupArtifacts(p.filePath, infos.fileName);
      infos.status = DownloadStatus.Queued;
      infos.fileName = '';
      infos.filePaths = [];
      infos.size = null;
      infos.downloaded = 0;
      infos.progress = null;
      infos.speed = 0;
      infos.eta = null;
      infos.error = null;
      infos.downloadedAt = null;
      infos.completedAt = null;

      this.items.push({
        item: { url: p.item.url, metadata: p.item.metadata } as DownloadItem,
        infos,
        filePath: '',
        speedSamples: [],
        restartAttempts: nextAttempts,
      });
      this.logger.log(`Re-queued ${p.item.url} (restart attempt ${nextAttempts}/${MAX_RESTART_ATTEMPTS})`);
    }

    await this.stateStore.flushNow();

    this.tickResolves();
    this.tickDownloads();
  }

  async onModuleDestroy(): Promise<void> {
    this.shuttingDown = true;
    for (const active of this.items) {
      if (!RESUMABLE_STATUSES.includes(active.infos.status)) {
        continue;
      }
      try {
        active.stream?.destroy();
      } catch {
        /* ignore */
      }
      active.stream = undefined;
      try {
        await active.resolved?.close?.();
      } catch {
        /* ignore */
      }
      active.resolved = undefined;
    }
    await this.stateStore.flushNow();
  }

  list(): DownloadingInfos[] {
    return this.items.map((item) => item.infos);
  }

  get(id: string): DownloadingInfos | undefined {
    return this.items.find((item) => item.infos.id === id)?.infos;
  }

  remove(id: string): void {
    const item = this.items.find((d) => d.infos.id === id);
    if (!item) {
      return;
    }

    this.items = this.items.filter((d) => d.infos.id !== id);
    this.eventEmitter.emit(DownloadServerTopic.Removed, { id });
    this.stateStore.scheduleFlush();
  }

  clearCompleted(): number {
    const toRemove = this.items.filter(
      (d) => d.infos.status === DownloadStatus.Completed || d.infos.status === DownloadStatus.Failed,
    );
    this.items = this.items.filter((d) => !toRemove.includes(d));

    for (const item of toRemove) {
      this.eventEmitter.emit(DownloadServerTopic.Removed, { id: item.infos.id });
    }

    this.logger.log(`Cleared ${toRemove.length} completed/failed downloads`);
    if (toRemove.length > 0) {
      this.stateStore.scheduleFlush();
    }
    return toRemove.length;
  }

  cancel(id: string): void {
    const item = this.items.find((d) => d.infos.id === id);
    if (!item || item.infos.status === DownloadStatus.Completed) {
      return;
    }

    item.stream?.destroy();
    void item.resolved?.close?.().catch(() => {});
    this.items = this.items.filter((d) => d.infos.id !== id);

    if (item.filePath && fs.existsSync(item.filePath)) {
      fs.unlinkSync(item.filePath);
    }

    this.logger.log(`Download ${item.infos.fileName} cancelled`);
    this.eventEmitter.emit(DownloadServerTopic.Canceled, { id: id });
    this.stateStore.scheduleFlush();
    this.dequeue();
  }

  async resolve(url: string): Promise<FileInfo> {
    const plugin = this.registry.findHostFor(url);
    if (!plugin) {
      throw new Error(`No plugin found for URL: ${url}`);
    }

    const resolved = await plugin.resolve({ url });
    void resolved.close?.().catch(() => {});
    return resolved.infos;
  }

  async download(item: DownloadItem, ctx?: RequestContext): Promise<DownloadingInfos> {
    const plugin = this.registry.findHostFor(item.url);
    if (!plugin) {
      throw new Error(`No plugin found for URL: ${item.url}`);
    }

    const active = this.createItem(item, plugin);
    active.ctx = ctx;
    this.items.push(active);
    this.stateStore.scheduleFlush();

    this.eventEmitter.emit(DownloadServerTopic.Registered, active.infos);

    this.tickResolves();

    return active.infos;
  }

  private createItem(item: DownloadItem, plugin: HostPlugin): ActiveDownload {
    return {
      item,
      infos: {
        id: uuidv4(),
        status: DownloadStatus.Queued,
        fileName: '',
        filePaths: [],
        size: null,
        downloaded: 0,
        progress: null,
        speed: 0,
        eta: null,
        error: null,
        source: plugin.name,
        metadata: item.metadata,
        createdAt: new Date(),
        downloadedAt: null,
        completedAt: null,
      },
      filePath: '',
      speedSamples: [],
      restartAttempts: 0,
    };
  }

  private async resolveItem(active: ActiveDownload, plugin: HostPlugin): Promise<void> {
    active.infos.status = DownloadStatus.Resolving;
    this.stateStore.scheduleFlush();
    this.emitProgress(active);

    try {
      const resolved = await plugin.resolve(active.item, active.ctx);

      if (!this.items.includes(active)) {
        await resolved.close?.().catch(() => {});
        return;
      }

      active.resolved = resolved;
      active.infos.fileName = resolved.infos.fileName;
      active.infos.size = resolved.infos.size;
      active.filePath = path.join(this.downloadsPath, resolved.infos.fileName);
      active.infos.status = DownloadStatus.Suspended;

      this.stateStore.scheduleFlush();
      this.emitProgress(active);
      this.eventEmitter.emit(DownloadServerTopic.Suspended, {
        id: active.infos.id,
        status: active.infos.status,
        fileName: active.infos.fileName,
        size: active.infos.size,
      });
      this.tickDownloads();
    } catch (error) {
      if (!this.items.includes(active)) {
        return;
      }
      this.fail(active, `Resolve failed for ${active.item.url}: ${error instanceof Error ? error.message : error}`);
    }
  }

  private async startStream(active: ActiveDownload): Promise<void> {
    if (!active.resolved) {
      this.fail(active, `Cannot start download for ${active.item.url}: not resolved`);
      return;
    }

    active.infos.status = DownloadStatus.Downloading;
    this.stateStore.scheduleFlush();

    try {
      const stream = await active.resolved.open();
      active.stream = stream;

      const { value, unit } = active.infos.size ? humanFileSize(active.infos.size) : { value: NaN, unit: '' };
      this.logger.log(`Downloading ${active.infos.fileName} (${value}${unit})`);
      this.emitProgress(active);

      await this.pipeToFile(active, stream);
    } catch (error) {
      this.fail(active, `Download failed for ${active.item.url}: ${error instanceof Error ? error.message : error}`);
    }
  }

  private async pipeToFile(active: ActiveDownload, stream: Readable): Promise<void> {
    const tracker = new Transform({
      transform: (chunk: Buffer, _encoding, callback) => {
        active.infos.downloaded += chunk.length;
        active.speedSamples.push({ timestamp: Date.now(), bytes: chunk.length });

        const now = Date.now();
        active.speedSamples = active.speedSamples.filter((s) => now - s.timestamp < SPEED_WINDOW_MS);

        active.infos.speed = computeSpeed(active.speedSamples);
        active.infos.eta = computeEta(active.infos.size, active.infos.downloaded, active.infos.speed);
        if (active.infos.size) {
          active.infos.progress = active.infos.downloaded / active.infos.size;
        }

        this.emitProgress(active);
        callback(null, chunk);
      },
    });

    await pipeline(stream, tracker, fs.createWriteStream(active.filePath));

    active.infos.speed = 0;
    active.infos.eta = null;
    active.infos.progress = 1;
    active.infos.downloadedAt = new Date();

    const archivePlugin = this.registry.findArchiveFor(active.filePath);
    if (archivePlugin) {
      await this.handleExtraction(active, archivePlugin);
    } else {
      active.infos.filePaths = [active.filePath];
      await this.complete(active);
    }
  }

  private async handleExtraction(active: ActiveDownload, archivePlugin: ArchivePlugin): Promise<void> {
    active.infos.status = DownloadStatus.Extracting;
    active.infos.progress = null;
    active.infos.speed = 0;
    active.infos.eta = null;
    this.stateStore.scheduleFlush();
    this.emitProgress(active);

    const baseName = active.infos.fileName.replace(/\.[^.]+$/, '');
    const targetDir = path.join(this.downloadsPath, baseName);
    fs.mkdirSync(targetDir, { recursive: true });

    this.logger.log(`Extracting with ${archivePlugin.name}: ${active.infos.fileName}`);

    try {
      const result = await archivePlugin.extract(active.filePath);
      let bytesWritten = 0;
      const filePaths: string[] = [];

      for await (const file of result.files) {
        const targetPath = path.join(targetDir, file.name);
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });

        const progressTracker = new Transform({
          transform: (chunk: Buffer, _encoding, callback) => {
            bytesWritten += chunk.length;
            if (result.totalSize > 0) {
              active.infos.progress = bytesWritten / result.totalSize;
              this.emitProgress(active);
            }
            callback(null, chunk);
          },
        });

        await pipeline(file.stream, progressTracker, fs.createWriteStream(targetPath));
        filePaths.push(targetPath);
      }

      fs.unlinkSync(active.filePath);
      active.infos.filePaths = filePaths;
      await this.complete(active);
    } catch (error) {
      this.fail(active, `Extraction failed: ${error instanceof Error ? error.message : error}`);
    }
  }

  private emitProgress(active: ActiveDownload): void {
    this.eventEmitter.emit(DownloadServerTopic.Progress, {
      id: active.infos.id,
      status: active.infos.status,
      fileName: active.infos.fileName,
      progress: active.infos.progress,
      speed: active.infos.speed,
      eta: active.infos.eta,
      downloaded: active.infos.downloaded,
    });
  }

  private fail(active: ActiveDownload, error: string): void {
    active.infos.status = DownloadStatus.Failed;
    active.infos.error = error;
    void active.resolved?.close?.().catch(() => {});
    active.resolved = undefined;
    active.stream = undefined;
    this.logger.error(error);

    this.eventEmitter.emit(DownloadServerTopic.Failed, {
      id: active.infos.id,
      fileName: active.infos.fileName,
      error: active.infos.error,
      source: active.infos.source,
    });

    void this.stateStore.flushNow();
    this.dequeue();
  }

  private async complete(active: ActiveDownload): Promise<void> {
    active.infos.status = DownloadStatus.Completed;
    active.infos.progress = 1;
    active.infos.completedAt = new Date();
    void active.resolved?.close?.().catch(() => {});
    active.resolved = undefined;
    active.stream = undefined;
    this.logger.log(`Completed: ${active.infos.fileName} (${active.infos.filePaths.length} file(s))`);

    await this.stateStore.flushNow();

    this.eventEmitter.emit(DownloadServerTopic.Completed, {
      id: active.infos.id,
      fileName: active.infos.fileName,
      filePaths: active.infos.filePaths,
      size: active.infos.size,
      source: active.infos.source,
      metadata: active.infos.metadata,
      downloadedAt: active.infos.downloadedAt,
      completedAt: active.infos.completedAt,
    });

    this.dequeue();
  }

  private dequeue(): void {
    this.tickDownloads();
    this.tickResolves();
  }

  private tickResolves(): void {
    if (this.shuttingDown) {
      return;
    }
    for (const item of this.items) {
      if (item.infos.status !== DownloadStatus.Queued) {
        continue;
      }
      const plugin = this.registry.findHostFor(item.item.url);
      if (!plugin) {
        this.fail(item, `No plugin found for URL: ${item.item.url}`);
        continue;
      }
      this.logger.log(`Resolving ${item.item.url}`);
      void this.resolveItem(item, plugin);
    }
  }

  private tickDownloads(): void {
    if (this.shuttingDown) {
      return;
    }
    while (true) {
      const downloadingCount = this.items.filter((d) => ACTIVE_DOWNLOAD_STATUSES.includes(d.infos.status)).length;
      if (downloadingCount >= this.maxConcurrent) {
        return;
      }
      const suspended = this.items.find((d) => d.infos.status === DownloadStatus.Suspended);
      if (!suspended) {
        return;
      }
      this.logger.log(`Starting download for ${suspended.infos.fileName}`);
      void this.startStream(suspended);
    }
  }

  private snapshot(): LiveItem[] {
    return this.items.map((a) => ({
      item: a.item,
      infos: a.infos,
      filePath: a.filePath,
      restartAttempts: a.restartAttempts,
    }));
  }

  private async cleanupArtifacts(filePath: string, fileName: string): Promise<void> {
    if (filePath) {
      await fsp.unlink(filePath).catch(() => {});
    }
    if (fileName) {
      const baseName = fileName.replace(/\.[^.]+$/, '');
      const extractDir = path.join(this.downloadsPath, baseName);
      await fsp.rm(extractDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
