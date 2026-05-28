import { Logger } from '@nestjs/common';
import type { WebSocket } from 'ws';
import type { z } from 'zod';

import { Envelope } from './envelope';

export type WsClient = WebSocket;

/**
 * Scope-bound sender provided by the router. Each service receives one
 * pre-bound to its scope, so `broadcast('progress', payload)` becomes the
 * wire event `<scope>::progress` without the service handling the prefix.
 */
export interface Transport {
  /** Emit to every client subscribed to `<scope>::<topic>`. */
  broadcast(topic: string, payload: unknown): void;
  /** Emit to a single client (no subscription required). */
  unicast(client: WsClient, topic: string, payload: unknown): void;
}

/** Handler for a single topic `K` of the event union `E`. */
export type Handler<E extends Envelope, K extends E['topic']> = (
  client: WsClient,
  payload: Extract<E, { topic: K }>['payload'],
) => void | Promise<void>;

/** Exhaustive handler map — one handler per topic in `E`. */
export type HandlerMap<E extends Envelope> = {
  [K in E['topic']]: Handler<E, K>;
};

/** Handler invoked once when a client subscribes to a given topic. */
export type SubscriptionHandler = (client: WsClient) => void;

/** Topic → subscription handler (typically a snapshot emit). */
export type SubscriptionHandlerMap = Record<string, SubscriptionHandler>;

/**
 * Contract a scope gateway exposes to the router. The router routes events
 * per scope and reads subscribers from the gateway to drive broadcasts.
 */
export interface IGateway {
  set transport(transport: Transport);

  onSubscribe(client: WsClient, topic: string): void;
  onUnsubscribe(client: WsClient, topic: string): void;
  onDisconnected(client: WsClient): void;

  /** Clients currently subscribed to `<scope>::<topic>` in this gateway. */
  subscribersOf(topic: string): ReadonlySet<WsClient>;

  onTextEvent?(client: WsClient, envelope: Envelope): Promise<void> | void;
  onBinaryEvent?(client: WsClient, buf: Buffer): void;
}

const EMPTY_CLIENTS: ReadonlySet<WsClient> = Object.freeze(new Set<WsClient>());

/**
 * Base class for scope gateways. Provides:
 *   - Transport injection (via setter)
 *   - Client-event dispatch (zod + handler map)
 *   - Subscription registry (topic → clients, with reverse lookup for cleanup)
 *   - Default `onSubscribe` that calls a custom snapshot handler if declared,
 *     otherwise registers the client for broadcasts
 *
 * Subclasses only wire their `eventHandlers` / `subscriptionHandlers` maps.
 * Snapshot handlers that also want to receive ongoing broadcasts call
 * {@link registerSubscriber} explicitly.
 */
export abstract class Gateway<E extends Envelope = never> implements IGateway {
  protected abstract readonly logger: Logger;

  /** Zod discriminated union of the scope's client events. Omit if none. */
  protected readonly eventSchema?: z.ZodType<E>;
  /** Exhaustive map: topic → handler. Omit if the scope has no uplink. */
  protected readonly eventHandlers?: HandlerMap<E>;
  /** Map: subscription topic → one-shot handler (snapshot emit, etc). */
  protected readonly subscriptionHandlers?: SubscriptionHandlerMap;

  private _transport: Transport | null = null;
  private readonly subscribersByTopic = new Map<string, Set<WsClient>>();
  private readonly topicsByClient = new WeakMap<WsClient, Set<string>>();

  get transport(): Transport {
    if (!this._transport) {
      throw new Error(`${this.constructor.name}: transport not attached`);
    }
    return this._transport;
  }

  set transport(transport: Transport) {
    this._transport = transport;
  }

  // ─────────────── client-event dispatch (uplink) ───────────────

  async onTextEvent(client: WsClient, envelope: Envelope): Promise<void> {
    if (!this.eventSchema || !this.eventHandlers) {
      return;
    }
    const parsed = this.eventSchema.safeParse(envelope);
    if (!parsed.success) {
      this.logger.warn(`Invalid client event: ${parsed.error.message}`);
      return;
    }
    const event = <E>parsed.data;
    const handlers = <Record<string, Handler<E, E['topic']>>>(<unknown>this.eventHandlers);
    const handler = <Handler<E, typeof event.topic>>handlers[event.topic];
    await handler(client, event.payload);
  }

  // ─────────────── subscription lifecycle ───────────────

  /**
   * Called by the router when a client subscribes to `<scope>::<topic>`.
   * If a {@link subscriptionHandlers} entry exists for the topic, it runs
   * instead of the default registration. The custom handler may call
   * {@link registerSubscriber} explicitly to also receive broadcasts.
   */
  onSubscribe(client: WsClient, topic: string): void {
    const custom = this.subscriptionHandlers?.[topic];
    if (custom) {
      custom(client);
      return;
    }
    this.registerSubscriber(client, topic);
  }

  /** Called by the router on `<scope>::<topic>` unsubscribe. Idempotent. */
  onUnsubscribe(client: WsClient, topic: string): void {
    this.unregisterSubscriber(client, topic);
  }

  /**
   * Called by the router when the client disconnects. Cleans all of this
   * client's subscriptions in O(k) where k = topics subscribed.
   *
   * Subclasses that override MUST call `super.onDisconnected(client)`.
   */
  onDisconnected(client: WsClient): void {
    const topics = this.topicsByClient.get(client);
    if (!topics) {
      return;
    }
    for (const topic of topics) {
      this.subscribersByTopic.get(topic)?.delete(client);
    }
    this.topicsByClient.delete(client);
  }

  /** Read-only view consumed by the router to build broadcasts. */
  subscribersOf(topic: string): ReadonlySet<WsClient> {
    return this.subscribersByTopic.get(topic) ?? EMPTY_CLIENTS;
  }

  /**
   * Register a client for future broadcasts of `topic`. Idempotent.
   * Meant to be called either as the default branch of {@link onSubscribe}
   * or explicitly by a custom snapshot handler that also wants updates.
   */
  protected registerSubscriber(client: WsClient, topic: string): void {
    let clients = this.subscribersByTopic.get(topic);
    if (!clients) {
      clients = new Set();
      this.subscribersByTopic.set(topic, clients);
    }
    clients.add(client);

    let topics = this.topicsByClient.get(client);
    if (!topics) {
      topics = new Set();
      this.topicsByClient.set(client, topics);
    }
    topics.add(topic);
  }

  /** Inverse of {@link registerSubscriber}. Idempotent. */
  protected unregisterSubscriber(client: WsClient, topic: string): void {
    this.subscribersByTopic.get(topic)?.delete(client);
    this.topicsByClient.get(client)?.delete(topic);
  }
}
