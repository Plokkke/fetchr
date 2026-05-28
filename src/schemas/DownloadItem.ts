import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export enum DownloadStatus {
  Queued = 'queued',
  Resolving = 'resolving',
  Suspended = 'suspended',
  Downloading = 'downloading',
  Extracting = 'extracting',
  Completed = 'completed',
  Failed = 'failed',
}

const downloadStatusSchema = z.enum(DownloadStatus);

const downloadItemSchema = z.object({
  url: z.url(),
  metadata: z.record(z.string(), z.string()).optional(),
});

const downloadInfoSchema = z.object({
  fileName: z.string(),
  size: z.number().nullable(),
});

export const downloadingInfosSchema = z.object({
  id: z.guid(),
  status: downloadStatusSchema,
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
  createdAt: z.coerce.date(),
  downloadedAt: z.coerce.date().nullable(),
  completedAt: z.coerce.date().nullable(),
});

export class DownloadItem extends createZodDto(downloadItemSchema) {}
export class DownloadInfos extends createZodDto(downloadInfoSchema) {}
export class DownloadingInfos extends createZodDto(downloadingInfosSchema) {}
