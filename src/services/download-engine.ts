import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';

import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';

import { DownloadServerTopic } from '@/gateways/protocols/download/topics';
import { ArchivePlugin } from '@/plugins/archive-plugin';
import { FileInfo, HostPlugin, ResolvedSource } from '@/plugins/host-plugin';
import { PluginRegistry } from '@/plugins/plugin-registry';
import { DownloadingInfos, DownloadItem, DownloadStatus } from '@/schemas/DownloadItem';
import { extractArchive } from '@/services/archive-extractor';
import { DownloadEventEmitter } from '@/services/download-events';
import { progressTracker, SpeedSample } from '@/services/download-progress';
import { remoteChanged, resetForRequeue } from '@/services/download-restore';
import { RequestContext } from '@/services/request-context';
import {
  adoptPartial,
  discardPartial,
  FRESH_START,
  openPartForWrite,
  OverlapVerifier,
  partPathOf,
  planResume,
  ResumeMismatchError,
  ResumePlan,
} from '@/services/resume';
import { LiveItem, PersistedItem, persistedToInfos, StateStore } from '@/services/state-store';
import { humanFileSize } from '@/utils';

const ACTIVE_DOWNLOAD_STATUSES = [DownloadStatus.Downloading, DownloadStatus.Extracting];
const TERMINAL_STATUSES = [DownloadStatus.Completed, DownloadStatus.Failed];
const RESUMABLE_STATUSES = [
  DownloadStatus.Resolving,
  DownloadStatus.Suspended,
  DownloadStatus.Downloading,
  DownloadStatus.Extracting,
];
const MAX_RESTART_ATTEMPTS = 3;

type ActiveDownload = {
  item: DownloadItem;
  infos: DownloadingInfos;
  ctx?: RequestContext;
  resolved?: ResolvedSource;
  stream?: Readable;
  filePath: string;
  speedSamples: { current: SpeedSample[] };
  restartAttempts: number;
  /** Set after a failed resume so the next attempt discards the partial file. */
  freshStart?: boolean;
};

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
      this.items.push(await this.restore(p));
    }
    await this.stateStore.flushNow();
    this.tickResolves();
    this.tickDownloads();
  }

  /**
   * Non-terminal items are re-queued with their partial file kept on disk, so
   * the next stream resumes from it once the source has been resolved again.
   */
  private async restore(p: PersistedItem): Promise<ActiveDownload> {
    const infos = persistedToInfos(p.infos);
    const active: ActiveDownload = {
      item: { url: p.item.url, metadata: p.item.metadata } as DownloadItem,
      infos,
      filePath: p.filePath,
      speedSamples: { current: [] },
      restartAttempts: p.restartAttempts ?? 0,
    };
    if (TERMINAL_STATUSES.includes(infos.status)) {
      return active;
    }

    if (!infos.paused) {
      active.restartAttempts += 1;
    }
    if (active.restartAttempts > MAX_RESTART_ATTEMPTS) {
      await this.cleanupArtifacts(p.filePath, infos.fileName);
      this.fail(active, `too many restart-retries (${active.restartAttempts})`, false);
      return active;
    }

    await this.cleanupExtraction(infos.fileName);
    resetForRequeue(infos, p.filePath ? await adoptPartial(p.filePath) : 0);
    this.logger.log(
      `Re-queued ${p.item.url} (restart attempt ${active.restartAttempts}/${MAX_RESTART_ATTEMPTS}, ${infos.downloaded} bytes on disk)`,
    );
    return active;
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
    this.forget(item);
    this.stateStore.scheduleFlush();
  }

  /**
   * Replaces the metadata of a download that has not completed yet, so the
   * `completed` event carries what the consumer decided after registration.
   */
  updateMetadata(id: string, metadata: Record<string, string>): DownloadingInfos | undefined {
    const item = this.items.find((d) => d.infos.id === id);
    if (!item || item.infos.status === DownloadStatus.Completed) {
      return undefined;
    }

    item.item.metadata = metadata;
    item.infos.metadata = metadata;
    this.logger.log(
      `Metadata replaced on ${item.infos.fileName || item.item.url}: ${Object.keys(metadata).join(', ') || '(empty)'}`,
    );
    this.eventEmitter.emit(DownloadServerTopic.Updated, { id, metadata });
    this.stateStore.scheduleFlush();
    return item.infos;
  }

  clearCompleted(): number {
    const toRemove = this.items.filter((d) => TERMINAL_STATUSES.includes(d.infos.status));
    this.items = this.items.filter((d) => !toRemove.includes(d));
    toRemove.forEach((item) => this.forget(item));

    this.logger.log(`Cleared ${toRemove.length} completed/failed downloads`);
    if (toRemove.length > 0) {
      this.stateStore.scheduleFlush();
    }
    return toRemove.length;
  }

  private forget(item: ActiveDownload): void {
    if (item.infos.status === DownloadStatus.Failed && item.filePath) {
      discardPartial(item.filePath);
    }
    this.eventEmitter.emit(DownloadServerTopic.Removed, { id: item.infos.id, metadata: item.infos.metadata });
  }

  cancel(id: string): void {
    const item = this.items.find((d) => d.infos.id === id);
    if (!item || item.infos.status === DownloadStatus.Completed) {
      return;
    }

    item.stream?.destroy();
    void item.resolved?.close?.().catch(() => {});
    this.items = this.items.filter((d) => d.infos.id !== id);

    if (item.filePath) {
      discardPartial(item.filePath);
    }

    this.logger.log(`Download ${item.infos.fileName} cancelled`);
    this.eventEmitter.emit(DownloadServerTopic.Canceled, { id, metadata: item.infos.metadata });
    this.stateStore.scheduleFlush();
    this.dequeue();
  }

  /** Pauses a download; its partial file stays on disk and is resumed by `resume`. */
  suspend(id: string): DownloadingInfos | undefined {
    const item = this.items.find((d) => d.infos.id === id);
    if (!item || item.infos.paused || ![...RESUMABLE_STATUSES, DownloadStatus.Queued].includes(item.infos.status)) {
      return undefined;
    }
    if (item.infos.status === DownloadStatus.Extracting) {
      return undefined;
    }

    item.infos.paused = true;
    if (item.infos.status === DownloadStatus.Downloading) {
      this.logger.log(`Suspending ${item.infos.fileName}`);
      const stream = item.stream;
      this.markSuspended(item);
      stream?.destroy();
      this.dequeue();
    }
    this.stateStore.scheduleFlush();
    return item.infos;
  }

  resume(id: string): DownloadingInfos | undefined {
    const item = this.items.find((d) => d.infos.id === id);
    if (!item?.infos.paused) {
      return undefined;
    }

    item.infos.paused = false;
    this.logger.log(`Resuming ${item.infos.fileName || item.item.url}`);
    if (item.infos.status === DownloadStatus.Suspended) {
      this.eventEmitter.emit(DownloadServerTopic.Resumed, this.lifecyclePayload(item));
    }
    this.stateStore.scheduleFlush();
    this.dequeue();
    return item.infos;
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
    const duplicate = this.items.find((d) => d.item.url === item.url && d.infos.status !== DownloadStatus.Failed);
    if (duplicate) {
      this.logger.log(`Already registered, returning existing item for ${item.url}`);
      return duplicate.infos;
    }

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
      speedSamples: { current: [] },
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

      await this.adoptResolved(active, resolved);
      this.markSuspended(active);
      this.tickDownloads();
    } catch (error) {
      if (!this.items.includes(active)) {
        return;
      }
      this.fail(active, `Resolve failed for ${active.item.url}: ${error instanceof Error ? error.message : error}`);
    }
  }

  /** Records what the host reports; a partial of a file that changed remotely is dropped. */
  private async adoptResolved(active: ActiveDownload, resolved: ResolvedSource): Promise<void> {
    if (active.filePath && remoteChanged(active.infos, resolved.infos)) {
      this.logger.warn(`Remote file changed for ${active.item.url}, discarding partial ${active.infos.fileName}`);
      discardPartial(active.filePath);
      active.infos.downloaded = 0;
      active.infos.progress = null;
    }

    active.resolved = resolved;
    active.infos.fileName = resolved.infos.fileName;
    active.infos.size = resolved.infos.size;
    active.infos.etag = resolved.infos.etag ?? active.infos.etag;
    active.infos.checksum = resolved.infos.checksum ?? active.infos.checksum;
    active.filePath = path.join(this.downloadsPath, resolved.infos.fileName);
  }

  private markSuspended(active: ActiveDownload): void {
    active.infos.status = DownloadStatus.Suspended;
    active.infos.speed = 0;
    active.infos.eta = null;
    active.stream = undefined;
    this.stateStore.scheduleFlush();
    this.emitProgress(active);
    this.eventEmitter.emit(DownloadServerTopic.Suspended, this.lifecyclePayload(active));
  }

  private lifecyclePayload(active: ActiveDownload) {
    return {
      id: active.infos.id,
      status: active.infos.status,
      fileName: active.infos.fileName,
      size: active.infos.size,
      metadata: active.infos.metadata,
    };
  }

  private async startStream(active: ActiveDownload): Promise<void> {
    if (!active.resolved) {
      this.fail(active, `Cannot start download for ${active.item.url}: not resolved`);
      return;
    }

    active.infos.status = DownloadStatus.Downloading;
    this.stateStore.scheduleFlush();

    let stream: Readable | undefined;
    try {
      const plan = active.freshStart ? FRESH_START : await this.prepareResume(active);
      active.freshStart = false;

      const opened = await active.resolved.open({ from: plan.from, etag: active.infos.etag });
      stream = opened.stream;
      active.stream = stream;
      active.infos.etag = opened.etag ?? active.infos.etag;

      const effective = opened.from === plan.from ? plan : FRESH_START;
      if (effective !== plan) {
        this.logger.warn(`Host served ${active.infos.fileName} from 0 instead of ${plan.from}, restarting`);
      }
      this.logStart(active, effective);

      await this.pipeToFile(active, stream, effective);
    } catch (error) {
      await this.handleStreamFailure(active, stream, error);
    }
  }

  private async prepareResume(active: ActiveDownload): Promise<ResumePlan> {
    await adoptPartial(active.filePath);
    return planResume(partPathOf(active.filePath), active.infos.size);
  }

  private logStart(active: ActiveDownload, plan: ResumePlan): void {
    const { value, unit } = active.infos.size ? humanFileSize(active.infos.size) : { value: NaN, unit: '' };
    const resume =
      plan.partialSize > 0 ? `, resuming at ${plan.partialSize} (verifying ${plan.expectedTail.length})` : '';
    this.logger.log(`Downloading ${active.infos.fileName} (${value}${unit}${resume})`);
  }

  /** A failure only counts if it comes from the stream the item still owns: a cancelled, suspended or superseded stream is ignored. */
  private async handleStreamFailure(
    active: ActiveDownload,
    stream: Readable | undefined,
    error: unknown,
  ): Promise<void> {
    if (this.shuttingDown || !this.items.includes(active) || active.stream !== stream) {
      return;
    }
    if (error instanceof ResumeMismatchError && !active.freshStart) {
      this.logger.warn(`Resume rejected for ${active.infos.fileName}: ${error.message}. Restarting from 0`);
      active.freshStart = true;
      discardPartial(active.filePath);
      await this.startStream(active);
      return;
    }
    this.fail(active, `Download failed for ${active.item.url}: ${error instanceof Error ? error.message : error}`);
  }

  private async pipeToFile(active: ActiveDownload, stream: Readable, plan: ResumePlan): Promise<void> {
    active.infos.downloaded = plan.partialSize;
    active.infos.progress = active.infos.size ? plan.partialSize / active.infos.size : null;
    this.emitProgress(active);

    const partPath = partPathOf(active.filePath);
    await pipeline(
      stream,
      new OverlapVerifier(plan.expectedTail),
      progressTracker(active.infos, active.speedSamples, () => this.emitProgress(active)),
      openPartForWrite(partPath, plan),
    );

    if (active.infos.size !== null && active.infos.downloaded !== active.infos.size) {
      throw new Error(`incomplete file: ${active.infos.downloaded} of ${active.infos.size} bytes`);
    }
    await fsp.rename(partPath, active.filePath);

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
    this.logger.log(`Extracting with ${archivePlugin.name}: ${active.infos.fileName}`);

    try {
      const filePaths = await extractArchive(
        archivePlugin,
        active.filePath,
        this.extractionDir(active.infos.fileName),
        (ratio) => {
          active.infos.progress = ratio;
          this.emitProgress(active);
        },
      );
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
      metadata: active.infos.metadata,
    });
  }

  private fail(active: ActiveDownload, error: string, dequeue = true): void {
    active.infos.status = DownloadStatus.Failed;
    active.infos.error = error;
    active.infos.speed = 0;
    active.infos.eta = null;
    void active.resolved?.close?.().catch(() => {});
    active.resolved = undefined;
    active.stream = undefined;
    this.logger.error(error);

    this.eventEmitter.emit(DownloadServerTopic.Failed, {
      id: active.infos.id,
      fileName: active.infos.fileName,
      error: active.infos.error,
      source: active.infos.source,
      metadata: active.infos.metadata,
    });

    if (dequeue) {
      void this.stateStore.flushNow();
      this.dequeue();
    }
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
      const next = this.items.find((d) => d.infos.status === DownloadStatus.Suspended && !d.infos.paused);
      if (!next) {
        return;
      }
      this.logger.log(`Starting download for ${next.infos.fileName}`);
      void this.startStream(next);
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

  private extractionDir(fileName: string): string {
    return path.join(this.downloadsPath, fileName.replace(/\.[^.]+$/, ''));
  }

  private async cleanupExtraction(fileName: string): Promise<void> {
    if (fileName) {
      await fsp.rm(this.extractionDir(fileName), { recursive: true, force: true }).catch(() => {});
    }
  }

  private async cleanupArtifacts(filePath: string, fileName: string): Promise<void> {
    if (filePath) {
      discardPartial(filePath);
    }
    await this.cleanupExtraction(fileName);
  }
}
