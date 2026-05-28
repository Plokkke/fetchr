import { z } from 'zod';

// ─────────────────────── binary frame ───────────────────────

/** Binary message-type byte for push chunks. Reserved range 0x01-0x1F. */
export const PUSH_CHUNK = 0x01;

export const BINARY_HEADER_SIZE = 29;
export const UUID_BYTES = 16;

export type BinaryFrame = {
  token: string;
  seq: number;
  idx: number;
  count: number;
  payload: Buffer;
};

export function uuidToBytes(uuid: string): Buffer {
  const hex = uuid.replace(/-/g, '');
  if (hex.length !== UUID_BYTES * 2) {
    throw new Error(`Invalid UUID: ${uuid}`);
  }
  return Buffer.from(hex, 'hex');
}

export function bytesToUuid(buf: Buffer, offset = 0): string {
  if (buf.length < offset + UUID_BYTES) {
    throw new Error(`Buffer too small for UUID at offset ${offset}: ${buf.length}`);
  }
  const hex = buf.subarray(offset, offset + UUID_BYTES).toString('hex');
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20, 32)].join('-');
}

export function encodePushChunk(token: string, seq: number, idx: number, count: number, payload: Buffer): Buffer {
  const frame = Buffer.allocUnsafe(BINARY_HEADER_SIZE + payload.length);
  frame.writeUInt8(PUSH_CHUNK, 0);
  uuidToBytes(token).copy(frame, 1);
  frame.writeUInt32BE(seq, 17);
  frame.writeUInt32BE(idx, 21);
  frame.writeUInt32BE(count, 25);
  payload.copy(frame, BINARY_HEADER_SIZE);
  return frame;
}

export function decodePushChunk(buf: Buffer): BinaryFrame | null {
  if (buf.length < BINARY_HEADER_SIZE) {
    return null;
  }
  if (buf.readUInt8(0) !== PUSH_CHUNK) {
    return null;
  }
  return {
    token: bytesToUuid(buf, 1),
    seq: buf.readUInt32BE(17),
    idx: buf.readUInt32BE(21),
    count: buf.readUInt32BE(25),
    payload: buf.subarray(BINARY_HEADER_SIZE),
  };
}

// ─────────────────────── client → server (text JSON) ───────────────────────

export enum UploadClientTopic {
  Error = 'error', // pusher signals it cannot read a chunk
}

const errorClientPayloadSchema = z.object({
  token: z.string(),
  seq: z.number(),
  reason: z.string(),
});

export type ErrorClientPayload = z.infer<typeof errorClientPayloadSchema>;

export const uploadClientEventSchema = z.discriminatedUnion('topic', [
  z.object({ topic: z.literal(UploadClientTopic.Error), payload: errorClientPayloadSchema }),
]);

export type UploadClientEvent<T extends UploadClientTopic = UploadClientTopic> = Extract<
  z.infer<typeof uploadClientEventSchema>,
  { topic: T }
>;

// ─────────────────────── server → client (text JSON, unicast) ───────────────────────

export enum UploadServerTopic {
  Read = 'read',
  Close = 'close',
  Error = 'error',
}

const readPayloadSchema = z.object({
  token: z.string(),
  seq: z.number(),
  start: z.number().optional(),
  length: z.number().optional(),
});

const closePayloadSchema = z.object({
  token: z.string(),
});

const errorServerPayloadSchema = z.object({
  token: z.string(),
  reason: z.string(),
});

export type ReadPayload = z.infer<typeof readPayloadSchema>;
export type ClosePayload = z.infer<typeof closePayloadSchema>;
export type ErrorServerPayload = z.infer<typeof errorServerPayloadSchema>;

export const uploadServerEventSchema = z.discriminatedUnion('topic', [
  z.object({ topic: z.literal(UploadServerTopic.Read), payload: readPayloadSchema }),
  z.object({ topic: z.literal(UploadServerTopic.Close), payload: closePayloadSchema }),
  z.object({ topic: z.literal(UploadServerTopic.Error), payload: errorServerPayloadSchema }),
]);

export type UploadServerEvent<T extends UploadServerTopic = UploadServerTopic> = Extract<
  z.infer<typeof uploadServerEventSchema>,
  { topic: T }
>;
