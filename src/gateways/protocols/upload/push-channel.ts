import type { BinaryFrame } from './topics';

export type { BinaryFrame };

export type Unsubscribe = () => void;

/**
 * Contract consumed by the fetchr-push plugin to pull bytes from a client
 * that registered via the WebSocket transport. The concrete implementation
 * (`WsPushChannel`) lives next to the upload service; this interface keeps
 * the plugin independent of any transport specifics.
 */
export interface PushChannel {
  sendRead(token: string, seq: number, start: number, length: number): void;
  sendClosed(token: string): void;
  sendError(token: string, reason: string): void;

  onBinary(token: string, handler: (frame: BinaryFrame) => void): Unsubscribe;
  onReadError(token: string, handler: (seq: number, reason: string) => void): Unsubscribe;

  readonly closed: Promise<{ reason: string }>;
}
