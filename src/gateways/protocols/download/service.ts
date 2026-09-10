import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';

import { Gateway, HandlerMap, SubscriptionHandlerMap, Transport } from '@/gateways/protocols/gateway';
import { DownloadEngine } from '@/services/download-engine';
import { DownloadEventEmitter } from '@/services/download-events';
import { WsRequestContext } from '@/services/request-context';

import { UploadService } from '../upload/service';

import {
  DownloadClientEvent,
  DownloadClientTopic,
  DownloadServerTopic,
  ProgressPayload,
  downloadClientEventSchema,
} from './topics';

const PROGRESS_THROTTLE_MS = 500;

@Injectable()
export class DownloadGateway extends Gateway<DownloadClientEvent> implements OnModuleDestroy {
  protected readonly logger = new Logger(DownloadGateway.name);
  protected readonly eventSchema = downloadClientEventSchema;
  protected readonly eventHandlers: HandlerMap<DownloadClientEvent>;
  protected readonly subscriptionHandlers: SubscriptionHandlerMap;

  private readonly pendingProgress = new Map<string, ProgressPayload>();
  private progressTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly engine: DownloadEngine,
    private readonly events: DownloadEventEmitter,
    private readonly uploads: UploadService,
  ) {
    super();
    this.eventHandlers = {
      [DownloadClientTopic.Register]: (client, payload) => {
        const channel = this.uploads.channelFor(client);
        const ctx = new WsRequestContext(channel);
        return this.engine.download({ url: payload.url, metadata: payload.metadata }, ctx);
      },
      [DownloadClientTopic.Cancel]: (_client, payload) => {
        this.engine.cancel(payload.id);
      },
      [DownloadClientTopic.Remove]: (_client, payload) => {
        this.engine.remove(payload.id);
      },
      [DownloadClientTopic.Clear]: () => {
        this.engine.clearCompleted();
      },
      [DownloadClientTopic.Update]: (_client, payload) => {
        const updated = this.engine.updateMetadata(payload.id, payload.metadata);
        if (!updated) {
          throw new Error(`Download ${payload.id} is unknown or already completed`);
        }
        return updated;
      },
      [DownloadClientTopic.Suspend]: (_client, payload) => {
        this.logger.warn(`suspend ${payload.id} — not implemented`);
      },
      [DownloadClientTopic.Resume]: (_client, payload) => {
        this.logger.warn(`resume ${payload.id} — not implemented`);
      },
    };
    this.subscriptionHandlers = {
      [DownloadServerTopic.List]: (client) => {
        this.transport.unicast(client, DownloadServerTopic.List, this.engine.list());
      },
    };
  }

  // JS quirk: when a subclass overrides `set`, the parent `get` is not
  // auto-inherited — it must be redeclared explicitly, otherwise `this.transport`
  // returns undefined on the instance.
  get transport(): Transport {
    return super.transport;
  }

  set transport(transport: Transport) {
    super.transport = transport;

    this.events.on(DownloadServerTopic.Registered, (p) => this.transport.broadcast(DownloadServerTopic.Registered, p));
    this.events.on(DownloadServerTopic.Suspended, (p) => this.transport.broadcast(DownloadServerTopic.Suspended, p));
    this.events.on(DownloadServerTopic.Completed, (p) => this.transport.broadcast(DownloadServerTopic.Completed, p));
    this.events.on(DownloadServerTopic.Failed, (p) => this.transport.broadcast(DownloadServerTopic.Failed, p));
    this.events.on(DownloadServerTopic.Canceled, (p) => this.transport.broadcast(DownloadServerTopic.Canceled, p));
    this.events.on(DownloadServerTopic.Removed, (p) => this.transport.broadcast(DownloadServerTopic.Removed, p));
    this.events.on(DownloadServerTopic.Updated, (p) => this.transport.broadcast(DownloadServerTopic.Updated, p));

    this.events.on(DownloadServerTopic.Progress, (p) => {
      this.pendingProgress.set(p.id, p);
    });

    this.progressTimer = setInterval(() => this.flushProgress(), PROGRESS_THROTTLE_MS);
  }

  onModuleDestroy(): void {
    if (this.progressTimer) {
      clearInterval(this.progressTimer);
      this.progressTimer = null;
    }
  }

  private flushProgress(): void {
    if (this.pendingProgress.size === 0) {
      return;
    }
    for (const [, payload] of this.pendingProgress) {
      this.transport.broadcast(DownloadServerTopic.Progress, payload);
    }
    this.pendingProgress.clear();
  }
}
