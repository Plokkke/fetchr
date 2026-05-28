import { Readable } from 'stream';

import { Injectable, Logger } from '@nestjs/common';

import { BinaryFrame, PushChannel, Unsubscribe } from '@/gateways/protocols/upload/push-channel';

const WINDOW_BYTES = 32 * 1024 * 1024;
const READABLE_HIGH_WATER_MARK = 4 * 1024 * 1024;

type PendingWindow = {
  seq: number;
  start: number;
  length: number;
  expectedCount: number | null;
  receivedCount: number;
  receivedBytes: number;
};

class SessionReadable extends Readable {
  onDemand: (() => void) | null = null;

  constructor() {
    super({ highWaterMark: READABLE_HIGH_WATER_MARK });
  }

  _read(): void {
    this.onDemand?.();
  }
}

export type SessionInfo = {
  fileName: string;
  size: number;
};

type Session = {
  token: string;
  channel: PushChannel;
  info: SessionInfo;
  state: 'Bound' | 'Open' | 'Closed';
  readable: SessionReadable | null;
  pendingWindow: PendingWindow | null;
  cursor: number;
  nextSeq: number;
  awaitingDemand: boolean;
  unsubBinary: Unsubscribe;
  unsubReadError: Unsubscribe;
};

@Injectable()
export class PushSessionManager {
  private readonly logger = new Logger(PushSessionManager.name);
  private readonly sessions = new Map<string, Session>();
  private readonly channelSessions = new Map<PushChannel, Set<string>>();

  bind(token: string, channel: PushChannel, info: SessionInfo): void {
    if (this.sessions.has(token)) {
      throw new Error(`Push token ${token} already bound`);
    }

    const session: Session = {
      token,
      channel,
      info,
      state: 'Bound',
      readable: null,
      pendingWindow: null,
      cursor: 0,
      nextSeq: 0,
      awaitingDemand: false,
      unsubBinary: channel.onBinary(token, (frame) => this.handleBinary(token, frame)),
      unsubReadError: channel.onReadError(token, (seq, reason) => this.handleReadError(token, seq, reason)),
    };
    this.sessions.set(token, session);

    let tokens = this.channelSessions.get(channel);
    if (!tokens) {
      tokens = new Set();
      this.channelSessions.set(channel, tokens);
      void channel.closed.then(({ reason }) => this.handleChannelClosed(channel, reason));
    }
    tokens.add(token);

    this.logger.log(`Bound push session ${token} for ${info.fileName} (${info.size} bytes)`);
  }

  openReadStream(token: string): Readable {
    const session = this.sessions.get(token);
    if (!session || session.state === 'Closed') {
      const r = new SessionReadable();
      r.destroy(new Error(`Push session ${token} not available`));
      return r;
    }

    session.state = 'Open';
    const readable = new SessionReadable();
    readable.onDemand = () => this.onConsumerDemand(session);
    session.readable = readable;

    if (session.info.size === 0) {
      readable.push(null);
      return readable;
    }

    this.requestNextWindow(session);
    return readable;
  }

  close(token: string, error?: string): void {
    const session = this.sessions.get(token);
    if (!session || session.state === 'Closed') {
      return;
    }
    session.state = 'Closed';

    if (error) {
      session.channel.sendError(token, error);
    } else {
      session.channel.sendClosed(token);
    }

    this.destroyReadable(session, error ? new Error(error) : null);
    this.teardown(session);
  }

  private requestNextWindow(session: Session): void {
    if (session.state === 'Closed' || !session.readable) {
      return;
    }
    if (session.cursor >= session.info.size) {
      session.readable.push(null);
      return;
    }

    const length = Math.min(WINDOW_BYTES, session.info.size - session.cursor);
    const seq = session.nextSeq;
    session.nextSeq += 1;
    session.pendingWindow = {
      seq,
      start: session.cursor,
      length,
      expectedCount: null,
      receivedCount: 0,
      receivedBytes: 0,
    };
    session.cursor += length;
    session.awaitingDemand = false;

    session.channel.sendRead(session.token, seq, session.pendingWindow.start, length);
    this.logger.debug(
      `Requested read token=${session.token} seq=${seq} start=${session.pendingWindow.start} length=${length}`,
    );
  }

  private onConsumerDemand(session: Session): void {
    if (session.awaitingDemand && session.pendingWindow === null) {
      this.requestNextWindow(session);
    }
  }

  private handleBinary(token: string, frame: BinaryFrame): void {
    const session = this.sessions.get(token);
    if (!session) {
      return;
    }

    const pending = session.pendingWindow;
    if (!pending || frame.seq !== pending.seq) {
      this.logger.warn(`Binary frame for unexpected seq=${frame.seq} on token=${token}`);
      return;
    }

    if (pending.expectedCount === null) {
      pending.expectedCount = frame.count;
    }

    const canContinue = session.readable?.push(frame.payload) ?? false;
    pending.receivedBytes += frame.payload.length;
    pending.receivedCount += 1;

    if (pending.receivedCount < frame.count) {
      return;
    }

    if (pending.receivedBytes !== pending.length) {
      this.logger.warn(
        `Window seq=${frame.seq} byte mismatch: expected ${pending.length}, got ${pending.receivedBytes}`,
      );
    }
    this.logger.debug(
      `Window seq=${frame.seq} completed on token=${token} (${pending.receivedBytes} bytes, cursor=${session.cursor}/${session.info.size})`,
    );
    session.pendingWindow = null;

    if (session.cursor >= session.info.size) {
      session.readable?.push(null);
      return;
    }

    if (canContinue) {
      this.requestNextWindow(session);
    } else {
      session.awaitingDemand = true;
    }
  }

  private handleReadError(token: string, seq: number, reason: string): void {
    const session = this.sessions.get(token);
    if (!session) {
      return;
    }
    const pending = session.pendingWindow;
    if (!pending || pending.seq !== seq) {
      return;
    }

    this.logger.warn(`Client read-error token=${token} seq=${seq}: ${reason}`);
    session.pendingWindow = null;
    session.readable?.destroy(new Error(`read-error: ${reason}`));
  }

  private handleChannelClosed(channel: PushChannel, reason: string): void {
    const tokens = this.channelSessions.get(channel);
    if (!tokens) {
      return;
    }

    this.logger.warn(`Push channel closed (${reason}), detaching ${tokens.size} session(s)`);
    for (const token of tokens) {
      const session = this.sessions.get(token);
      if (!session || session.state === 'Closed') {
        continue;
      }
      session.state = 'Closed';
      this.destroyReadable(session, new Error(`channel closed: ${reason}`));
      this.teardown(session, { skipChannelRemoval: true });
    }
    this.channelSessions.delete(channel);
  }

  private destroyReadable(session: Session, error: Error | null): void {
    if (!session.readable) {
      return;
    }
    if (error) {
      session.readable.destroy(error);
    } else {
      session.readable.push(null);
    }
  }

  private teardown(session: Session, opts: { skipChannelRemoval?: boolean } = {}): void {
    session.unsubBinary();
    session.unsubReadError();
    this.sessions.delete(session.token);

    if (!opts.skipChannelRemoval) {
      const tokens = this.channelSessions.get(session.channel);
      if (tokens) {
        tokens.delete(session.token);
        if (tokens.size === 0) {
          this.channelSessions.delete(session.channel);
        }
      }
    }
  }
}
