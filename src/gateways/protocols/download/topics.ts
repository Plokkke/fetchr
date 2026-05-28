import { z } from 'zod';

import { downloadingInfosSchema } from '@/schemas/DownloadItem';

// ─────────────────────── client → server (uplink) ───────────────────────

export enum DownloadClientTopic {
  Register = 'register',
  Cancel = 'cancel',
  Suspend = 'suspend',
  Resume = 'resume',
  Remove = 'remove',
  Clear = 'clear',
}

const registerPayloadSchema = z.object({
  url: z.string(),
  metadata: z.record(z.string(), z.string()).optional(),
});
const cancelPayloadSchema = z.object({ id: z.string() });
const suspendPayloadSchema = z.object({ id: z.string() });
const resumePayloadSchema = z.object({ id: z.string() });
const removePayloadSchema = z.object({ id: z.string() });
const clearPayloadSchema = z.object({}).strict();

export type RegisterPayload = z.infer<typeof registerPayloadSchema>;
export type CancelPayload = z.infer<typeof cancelPayloadSchema>;
export type SuspendPayload = z.infer<typeof suspendPayloadSchema>;
export type ResumePayload = z.infer<typeof resumePayloadSchema>;
export type RemovePayload = z.infer<typeof removePayloadSchema>;
export type ClearPayload = z.infer<typeof clearPayloadSchema>;

export const downloadClientEventSchema = z.discriminatedUnion('topic', [
  z.object({ topic: z.literal(DownloadClientTopic.Register), payload: registerPayloadSchema }),
  z.object({ topic: z.literal(DownloadClientTopic.Cancel), payload: cancelPayloadSchema }),
  z.object({ topic: z.literal(DownloadClientTopic.Suspend), payload: suspendPayloadSchema }),
  z.object({ topic: z.literal(DownloadClientTopic.Resume), payload: resumePayloadSchema }),
  z.object({ topic: z.literal(DownloadClientTopic.Remove), payload: removePayloadSchema }),
  z.object({ topic: z.literal(DownloadClientTopic.Clear), payload: clearPayloadSchema }),
]);

export type DownloadClientEvent<T extends DownloadClientTopic = DownloadClientTopic> = Extract<
  z.infer<typeof downloadClientEventSchema>,
  { topic: T }
>;

// ─────────────────────── server → clients (downlink) ───────────────────────

export enum DownloadServerTopic {
  Registered = 'registered',
  Progress = 'progress',
  Suspended = 'suspended',
  Resumed = 'resumed',
  Completed = 'completed',
  Failed = 'failed',
  Canceled = 'canceled',
  Removed = 'removed',
  List = 'list',
}

/** Topics that broadcast to all clients subscribed to them. */
export const DOWNLOAD_BROADCAST_TOPICS = [
  DownloadServerTopic.Registered,
  DownloadServerTopic.Progress,
  DownloadServerTopic.Suspended,
  DownloadServerTopic.Resumed,
  DownloadServerTopic.Completed,
  DownloadServerTopic.Failed,
  DownloadServerTopic.Canceled,
  DownloadServerTopic.Removed,
] as const;
export type DownloadBroadcastTopic = (typeof DOWNLOAD_BROADCAST_TOPICS)[number];

/** Topics that send a one-shot snapshot when the client subscribes to them. */
export const DOWNLOAD_SNAPSHOT_TOPICS = [DownloadServerTopic.List] as const;
export type DownloadSnapshotTopic = (typeof DOWNLOAD_SNAPSHOT_TOPICS)[number];

const registeredPayloadSchema = downloadingInfosSchema;
const progressPayloadSchema = z.object({
  id: z.string(),
  status: z.string(),
  fileName: z.string(),
  progress: z.number().nullable(),
  speed: z.number(),
  eta: z.number().nullable(),
  downloaded: z.number(),
});
const suspendedPayloadSchema = downloadingInfosSchema.pick({
  id: true,
  status: true,
  fileName: true,
  size: true,
});
const resumedPayloadSchema = downloadingInfosSchema.pick({
  id: true,
  status: true,
  fileName: true,
  size: true,
});
const completedPayloadSchema = downloadingInfosSchema.pick({
  id: true,
  fileName: true,
  filePaths: true,
  size: true,
  source: true,
  metadata: true,
  downloadedAt: true,
  completedAt: true,
});
const failedPayloadSchema = downloadingInfosSchema.pick({
  id: true,
  fileName: true,
  error: true,
  source: true,
});
const canceledPayloadSchema = z.object({ id: z.string() });
const removedPayloadSchema = z.object({ id: z.string() });
const listPayloadSchema = z.array(downloadingInfosSchema);

export type RegisteredPayload = z.infer<typeof registeredPayloadSchema>;
export type ProgressPayload = z.infer<typeof progressPayloadSchema>;
export type SuspendedPayload = z.infer<typeof suspendedPayloadSchema>;
export type ResumedPayload = z.infer<typeof resumedPayloadSchema>;
export type CompletedPayload = z.infer<typeof completedPayloadSchema>;
export type FailedPayload = z.infer<typeof failedPayloadSchema>;
export type CanceledPayload = z.infer<typeof canceledPayloadSchema>;
export type RemovedPayload = z.infer<typeof removedPayloadSchema>;
export type ListPayload = z.infer<typeof listPayloadSchema>;

export const downloadServerEventSchema = z.discriminatedUnion('topic', [
  z.object({ topic: z.literal(DownloadServerTopic.Registered), payload: registeredPayloadSchema }),
  z.object({ topic: z.literal(DownloadServerTopic.Progress), payload: progressPayloadSchema }),
  z.object({ topic: z.literal(DownloadServerTopic.Suspended), payload: suspendedPayloadSchema }),
  z.object({ topic: z.literal(DownloadServerTopic.Resumed), payload: resumedPayloadSchema }),
  z.object({ topic: z.literal(DownloadServerTopic.Completed), payload: completedPayloadSchema }),
  z.object({ topic: z.literal(DownloadServerTopic.Failed), payload: failedPayloadSchema }),
  z.object({ topic: z.literal(DownloadServerTopic.Canceled), payload: canceledPayloadSchema }),
  z.object({ topic: z.literal(DownloadServerTopic.Removed), payload: removedPayloadSchema }),
  z.object({ topic: z.literal(DownloadServerTopic.List), payload: listPayloadSchema }),
]);

export type DownloadServerEvent<T extends DownloadServerTopic = DownloadServerTopic> = Extract<
  z.infer<typeof downloadServerEventSchema>,
  { topic: T }
>;
