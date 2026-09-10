import { z } from 'zod';

/**
 * "Global" topics are transport-level (subscribe/unsubscribe) and have no
 * scope prefix on the wire. They are handled directly by the router.
 */
export enum GlobalTopic {
  Subscribe = 'subscribe',
  Unsubscribe = 'unsubscribe',
  /** Server → client answer to an uplink event that carried a `requestId`. */
  Ack = 'ack',
}

export type AckOutcome = { ok: true; data?: unknown } | { ok: false; error: string };
export type AckPayload = AckOutcome & { requestId: string };

const subscribePayloadSchema = z.object({ topics: z.array(z.string()) });
const unsubscribePayloadSchema = z.object({ topics: z.array(z.string()) });

export type SubscribePayload = z.infer<typeof subscribePayloadSchema>;
export type UnsubscribePayload = z.infer<typeof unsubscribePayloadSchema>;

export const globalClientEventSchema = z.discriminatedUnion('topic', [
  z.object({ topic: z.literal(GlobalTopic.Subscribe), payload: subscribePayloadSchema }),
  z.object({ topic: z.literal(GlobalTopic.Unsubscribe), payload: unsubscribePayloadSchema }),
]);

export type GlobalClientEvent = z.infer<typeof globalClientEventSchema>;

export const GLOBAL_TOPICS = [GlobalTopic.Subscribe, GlobalTopic.Unsubscribe] as const;
