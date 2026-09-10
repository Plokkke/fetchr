import type { IncomingMessage } from 'http';

import { Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OnGatewayConnection, OnGatewayDisconnect, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import type { Server } from 'ws';

import { Config } from '@/app.module';

import {
  AckOutcome,
  AckPayload,
  Scope,
  envelopeSchema,
  globalClientEventSchema,
  parseScope,
  scopeTopic,
  GlobalTopic,
  GlobalClientEvent,
} from './protocols';
import { DownloadGateway } from './protocols/download/service';
import { IGateway, Transport, WsClient } from './protocols/gateway';
import { SettingsService } from './protocols/settings/service';
import { UploadService } from './protocols/upload/service';

const PING_INTERVAL_MS = 30_000;
const AUTH_HEADER = 'x-api-key';
const WS_CLOSE_AUTH = 4401;

type Client = WsClient & { isAlive?: boolean };

/**
 * Thin transport router for the fetchr WebSocket.
 *
 * Responsibilities:
 *   - Authenticate connections, manage lifecycle (ping, disconnect cleanup).
 *   - Handle global topics directly (`subscribe`, `unsubscribe`).
 *   - Dispatch scoped client events / subs / binary frames to the matching
 *     {@link IGateway}.
 *   - Provide each registered gateway with a scope-bound {@link Transport}
 *     that prefixes outgoing topics and reads subscribers from the gateway.
 *
 * Subscription registries live inside each gateway (see {@link IGateway.subscribersOf}).
 */
@WebSocketGateway()
export class GlobalGateway implements OnGatewayConnection, OnGatewayDisconnect, OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(GlobalGateway.name);
  private readonly services = new Map<Scope, IGateway>();
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  @WebSocketServer()
  server!: Server;

  constructor(
    private readonly configService: ConfigService<Config, true>,
    private readonly downloadService: DownloadGateway,
    private readonly settingsService: SettingsService,
    private readonly uploadService: UploadService,
  ) {}

  // ───────────────────────── lifecycle ─────────────────────────

  onModuleInit(): void {
    this.register(Scope.Download, this.downloadService);
    this.register(Scope.Settings, this.settingsService);
    this.register(Scope.Upload, this.uploadService);

    this.pingTimer = setInterval(() => this.pingAll(), PING_INTERVAL_MS);
  }

  onModuleDestroy(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  // ───────────────────────── service registration ─────────────────────────

  register(scope: Scope, service: IGateway): void {
    this.services.set(scope, service);
    service.transport = this.scopedTransport(scope, service);
    this.logger.log(`Registered service for scope "${scope}"`);
  }

  // ───────────────────────── connection lifecycle ─────────────────────────

  handleConnection(client: Client, request: IncomingMessage): void {
    const expected = this.configService.get('server.apiKey', { infer: true });
    const fromHeader = request.headers[AUTH_HEADER];
    const fromQuery = new URL(request.url ?? '/', 'http://placeholder').searchParams.get('apiKey');
    const provided = typeof fromHeader === 'string' ? fromHeader : fromQuery;
    if (provided !== expected) {
      this.logger.warn(`Rejected WS connection from ${request.socket.remoteAddress}: invalid api key`);
      client.close(WS_CLOSE_AUTH, 'invalid api key');
      return;
    }

    client.isAlive = true;
    this.logger.log(`Client connected from ${request.socket.remoteAddress}`);

    client.on('pong', () => {
      client.isAlive = true;
    });

    client.on('message', (raw: Buffer, isBinary: boolean) => {
      const promise = isBinary ? this.handleBinary(client, raw) : this.handleText(client, raw.toString());
      Promise.resolve(promise).catch((err) => {
        this.logger.error(`Handler error: ${err instanceof Error ? err.message : err}`);
      });
    });

    client.on('error', (err) => {
      this.logger.warn(`Client error: ${err.message}`);
    });
  }

  handleDisconnect(client: Client): void {
    for (const service of this.services.values()) {
      service.onDisconnected(client);
    }
  }

  // ───────────────────────── inbound dispatch ─────────────────────────

  private async handleText(client: Client, raw: string): Promise<void> {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      this.logger.warn('Malformed JSON message received');
      return;
    }

    const envelope = envelopeSchema.safeParse(json);
    if (!envelope.success) {
      this.logger.warn(`Invalid envelope: ${envelope.error.message}`);
      return;
    }

    const { topic, payload, requestId } = envelope.data;

    const split = parseScope(topic);
    if (!split.scope) {
      this.dispatchGlobal(client, json);
      return;
    }

    const service = this.services.get(split.scope as Scope);
    if (!service?.onTextEvent) {
      this.logger.warn(`No service registered for scope "${split.scope}"`);
      this.ack(client, requestId, { ok: false, error: `Unknown scope "${split.scope}"` });
      return;
    }

    try {
      const data = await service.onTextEvent(client, { topic: split.topic, payload });
      this.ack(client, requestId, { ok: true, data });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.logger.warn(`${topic} failed: ${error}`);
      this.ack(client, requestId, { ok: false, error });
    }
  }

  /** Answers an uplink event that carried a `requestId`; silent otherwise. */
  private ack(client: Client, requestId: string | undefined, outcome: AckOutcome): void {
    if (!requestId) {
      return;
    }
    const payload: AckPayload = { requestId, ...outcome };
    this.send(client, JSON.stringify({ topic: GlobalTopic.Ack, payload }));
  }

  private handleBinary(client: Client, buf: Buffer): void {
    if (buf.length === 0) {
      return;
    }
    for (const service of this.services.values()) {
      service.onBinaryEvent?.(client, buf);
    }
  }

  // ───────────────────────── global topics ─────────────────────────

  private dispatchGlobal(client: Client, json: unknown): void {
    const result = globalClientEventSchema.safeParse(json);
    if (!result.success) {
      this.logger.warn(`Invalid global event: ${result.error.message}`);
      return;
    }
    const event: GlobalClientEvent = result.data;
    switch (event.topic) {
      case GlobalTopic.Subscribe:
        this.handleSubscribe(client, event.payload.topics);
        break;
      case GlobalTopic.Unsubscribe:
        this.handleUnsubscribe(client, event.payload.topics);
        break;
    }
  }

  private handleSubscribe(client: Client, wireTopics: string[]): void {
    for (const wire of wireTopics) {
      const split = parseScope(wire);
      if (!split.scope) {
        this.logger.warn(`Cannot subscribe to non-scoped topic: ${split.topic}`);
        continue;
      }
      this.services.get(split.scope as Scope)?.onSubscribe(client, split.topic);
    }
  }

  private handleUnsubscribe(client: Client, wireTopics: string[]): void {
    for (const wire of wireTopics) {
      const split = parseScope(wire);
      if (!split.scope) {
        continue;
      }
      this.services.get(split.scope as Scope)?.onUnsubscribe(client, split.topic);
    }
  }

  // ───────────────────────── outbound senders ─────────────────────────

  private scopedTransport(scope: Scope, service: IGateway): Transport {
    return {
      broadcast: (topic, payload) => {
        const subs = service.subscribersOf(topic);
        if (subs.size === 0) {
          return;
        }
        const message = JSON.stringify({ topic: scopeTopic(scope, topic), payload });
        for (const client of subs) {
          this.send(<Client>client, message);
        }
      },
      unicast: (client, topic, payload) => {
        this.send(<Client>client, JSON.stringify({ topic: scopeTopic(scope, topic), payload }));
      },
    };
  }

  private send(client: Client, message: string): void {
    if (client.readyState !== client.OPEN) {
      return;
    }
    client.send(message);
  }

  // ───────────────────────── ping ─────────────────────────

  private pingAll(): void {
    for (const client of this.server.clients as Set<Client>) {
      if (client.isAlive === false) {
        this.logger.warn('Client failed ping-pong, terminating');
        client.terminate();
        continue;
      }
      client.isAlive = false;
      try {
        client.ping();
      } catch {
        // ignore
      }
    }
  }
}
