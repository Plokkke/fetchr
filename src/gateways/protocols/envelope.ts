import { z } from 'zod';

/**
 * Minimal wire envelope: every WS JSON message has shape `{ topic, payload }`.
 * The router parses this first to extract the topic, then delegates payload
 * validation to the appropriate scope's schema.
 *
 * A client may attach a `requestId` to a scoped uplink event; the router then
 * answers with a global `ack` carrying that id, the outcome and the handler result.
 */
export const envelopeSchema = z.object({
  topic: z.string(),
  payload: z.unknown().optional(),
  requestId: z.string().min(1).max(128).optional(),
});

export type Envelope = z.infer<typeof envelopeSchema>;

export const SCOPE_SEPARATOR = '::';

/** Compose a wire topic from a scope and an action: `download::register`. */
export function scopeTopic(scope: string, action: string): string {
  return `${scope}${SCOPE_SEPARATOR}${action}`;
}

/** Split a wire topic into [scope, action]. Returns null when no scope present. */
export function parseScope(topic: string): { scope?: string; topic: string } {
  const idx = topic.indexOf(SCOPE_SEPARATOR);
  if (idx === -1) {
    return { topic };
  }
  return { scope: topic.slice(0, idx), topic: topic.slice(idx + SCOPE_SEPARATOR.length) };
}
