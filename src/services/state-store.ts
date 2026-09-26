import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { z } from 'zod';

import { HealthService } from '@/modules/health/health.service';
import { DownloadingInfos, DownloadItem, DownloadStatus } from '@/schemas/DownloadItem';

const STATE_VERSION = 1;
const FILE_NAME = '.fetchr-state.json';
const DEBOUNCE_MS = 500;

const persistedInfosSchema = z.object({
  id: z.string(),
  status: z.enum(DownloadStatus),
  fileName: z.string(),
  filePaths: z.array(z.string()),
  size: z.number().nullable(),
  downloaded: z.number(),
  progress: z.number().nullable(),
  speed: z.number(),
  eta: z.number().nullable(),
  error: z.string().nullable(),
  source: z.string(),
  metadata: z.record(z.string(), z.string()).optional(),
  etag: z.string().nullable().optional(),
  checksum: z.string().nullable().optional(),
  paused: z.boolean().optional(),
  createdAt: z.string(),
  downloadedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
});

const persistedItemSchema = z.object({
  infos: persistedInfosSchema,
  item: z.object({ url: z.string(), metadata: z.record(z.string(), z.string()).optional() }),
  filePath: z.string(),
  restartAttempts: z.number().int().min(0).optional().default(0),
});

const stateFileSchema = z.object({
  version: z.literal(STATE_VERSION),
  updatedAt: z.string(),
  items: z.array(persistedItemSchema),
});

export type PersistedItem = z.infer<typeof persistedItemSchema>;

export type LiveItem = {
  item: DownloadItem;
  infos: DownloadingInfos;
  filePath: string;
  restartAttempts: number;
};

function infosToPersisted(i: DownloadingInfos): z.infer<typeof persistedInfosSchema> {
  return {
    id: i.id,
    status: i.status,
    fileName: i.fileName,
    filePaths: i.filePaths,
    size: i.size,
    downloaded: i.downloaded,
    progress: i.progress,
    speed: i.speed,
    eta: i.eta,
    error: i.error,
    source: i.source,
    metadata: i.metadata,
    etag: i.etag,
    checksum: i.checksum,
    paused: i.paused,
    createdAt: i.createdAt.toISOString(),
    downloadedAt: i.downloadedAt ? i.downloadedAt.toISOString() : null,
    completedAt: i.completedAt ? i.completedAt.toISOString() : null,
  };
}

export function persistedToInfos(p: z.infer<typeof persistedInfosSchema>): DownloadingInfos {
  return {
    id: p.id,
    status: p.status,
    fileName: p.fileName,
    filePaths: p.filePaths,
    size: p.size,
    downloaded: p.downloaded,
    progress: p.progress,
    speed: p.speed,
    eta: p.eta,
    error: p.error,
    source: p.source,
    metadata: p.metadata,
    etag: p.etag,
    checksum: p.checksum,
    paused: p.paused,
    createdAt: new Date(p.createdAt),
    downloadedAt: p.downloadedAt ? new Date(p.downloadedAt) : null,
    completedAt: p.completedAt ? new Date(p.completedAt) : null,
  };
}

@Injectable()
export class StateStore implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(StateStore.name);
  private readonly filePath: string;
  private readonly tmpPath: string;
  private debounceTimer: NodeJS.Timeout | null = null;
  private writing = false;
  private pendingAfterWrite = false;
  private source: () => LiveItem[] = () => [];

  constructor(
    private readonly downloadsPath: string,
    private readonly health?: HealthService,
  ) {
    this.filePath = path.join(this.downloadsPath, FILE_NAME);
    this.tmpPath = `${this.filePath}.tmp`;
  }

  setSource(source: () => LiveItem[]): void {
    this.source = source;
  }

  async onModuleInit(): Promise<void> {
    await fsp.mkdir(this.downloadsPath, { recursive: true });
    if (this.health) {
      this.health.addReadinessCheck('state-writable', () => this.canWriteState());
    }
  }

  private async canWriteState(): Promise<boolean> {
    try {
      await fsp.access(this.downloadsPath, fs.constants.W_OK);
      return true;
    } catch (err) {
      this.logger.warn(`State-writable check failed for ${this.downloadsPath}: ${(err as Error).message}`);
      return false;
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    await this.flushNow();
  }

  async load(): Promise<PersistedItem[]> {
    try {
      const raw = await fsp.readFile(this.filePath, 'utf8');
      const parsed = stateFileSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) {
        this.logger.warn(`State file schema mismatch, starting empty: ${parsed.error.message}`);
        await this.backupCorruptFile();
        return [];
      }
      this.logger.log(`Loaded ${parsed.data.items.length} items from state file`);
      return parsed.data.items;
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'ENOENT') {
        this.logger.log('No state file found, starting fresh');
        return [];
      }
      this.logger.error(`Failed to read state file: ${e.message}`);
      await this.backupCorruptFile();
      return [];
    }
  }

  scheduleFlush(): void {
    if (this.debounceTimer) {
      return;
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.flushNow();
    }, DEBOUNCE_MS);
  }

  async flushNow(): Promise<void> {
    if (this.writing) {
      this.pendingAfterWrite = true;
      return;
    }
    this.writing = true;
    try {
      if (this.debounceTimer) {
        clearTimeout(this.debounceTimer);
        this.debounceTimer = null;
      }
      const payload = this.serialize();
      await fsp.writeFile(this.tmpPath, payload, { encoding: 'utf8', mode: 0o640 });
      await fsp.rename(this.tmpPath, this.filePath);
    } catch (err) {
      this.logger.error(`Failed to persist state: ${(err as Error).message}`);
    } finally {
      this.writing = false;
      if (this.pendingAfterWrite) {
        this.pendingAfterWrite = false;
        this.scheduleFlush();
      }
    }
  }

  flushSync(): void {
    try {
      const payload = this.serialize();
      fs.writeFileSync(this.tmpPath, payload);
      fs.renameSync(this.tmpPath, this.filePath);
    } catch {
      /* best effort */
    }
  }

  private serialize(): string {
    const items: PersistedItem[] = this.source().map((li) => ({
      infos: infosToPersisted(li.infos),
      item: { url: li.item.url, metadata: li.item.metadata },
      filePath: li.filePath,
      restartAttempts: li.restartAttempts,
    }));
    return JSON.stringify({ version: STATE_VERSION, updatedAt: new Date().toISOString(), items }, null, 2);
  }

  private async backupCorruptFile(): Promise<void> {
    try {
      const backup = `${this.filePath}.corrupt-${Date.now()}`;
      await fsp.rename(this.filePath, backup);
      this.logger.warn(`Moved corrupt state file to ${backup}`);
    } catch {
      /* file may already be gone */
    }
  }
}
