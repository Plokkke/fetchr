import { EventEmitter } from 'node:events';

import { BinaryFrame, PushChannel, Unsubscribe } from './push-channel';
import { UploadServerTopic } from './topics';

type UnicastFn = (topic: string, payload: unknown) => void;

/**
 * Concrete {@link PushChannel} backed by a single WebSocket connection.
 *
 * Internally uses a private EventEmitter (composition) to multiplex handlers
 * by `${event}:${token}`. External callers never touch the emitter's
 * `on`/`off`/`emit` surface — only the governed API below.
 */
export class WsPushChannel implements PushChannel {
  private readonly bus = new EventEmitter();
  readonly closed: Promise<{ reason: string }>;
  private resolveClosed!: (r: { reason: string }) => void;
  private closedFlag = false;

  constructor(private readonly unicast: UnicastFn) {
    this.closed = new Promise((resolve) => {
      this.resolveClosed = resolve;
    });
  }

  // ─────── outgoing (server → client) ───────

  sendRead(token: string, seq: number, start: number, length: number): void {
    this.unicast(UploadServerTopic.Read, { token, seq, start, length });
  }

  sendClosed(token: string): void {
    this.unicast(UploadServerTopic.Close, { token });
  }

  sendError(token: string, reason: string): void {
    this.unicast(UploadServerTopic.Error, { token, reason });
  }

  // ─────── incoming handler registration (used by PushSessionManager) ───────

  onBinary(token: string, handler: (frame: BinaryFrame) => void): Unsubscribe {
    return this.subscribe(`binary:${token}`, handler as (...args: unknown[]) => void);
  }

  onReadError(token: string, handler: (seq: number, reason: string) => void): Unsubscribe {
    return this.subscribe(`read-error:${token}`, handler as (...args: unknown[]) => void);
  }

  // ─────── incoming dispatch (used by UploadService) ───────

  routeBinary(frame: BinaryFrame): void {
    this.bus.emit(`binary:${frame.token}`, frame);
  }

  routeReadError(payload: { token: string; seq: number; reason: string }): void {
    this.bus.emit(`read-error:${payload.token}`, payload.seq, payload.reason);
  }

  markClosed(reason: string): void {
    if (this.closedFlag) {
      return;
    }
    this.closedFlag = true;
    this.resolveClosed({ reason });
    this.bus.removeAllListeners();
  }

  private subscribe(event: string, handler: (...args: unknown[]) => void): Unsubscribe {
    this.bus.on(event, handler);
    return () => this.bus.off(event, handler);
  }
}
