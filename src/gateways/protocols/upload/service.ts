import { Injectable, Logger } from '@nestjs/common';

import { Gateway, HandlerMap, WsClient } from '@/gateways/protocols/gateway';

import { decodePushChunk, UploadClientEvent, UploadClientTopic, uploadClientEventSchema } from './topics';
import { WsPushChannel } from './ws-push-channel';

@Injectable()
export class UploadService extends Gateway<UploadClientEvent> {
  protected readonly logger = new Logger(UploadService.name);
  protected readonly eventSchema = uploadClientEventSchema;
  protected readonly eventHandlers: HandlerMap<UploadClientEvent>;

  private readonly channels = new WeakMap<WsClient, WsPushChannel>();

  constructor() {
    super();
    this.eventHandlers = {
      [UploadClientTopic.Error]: (client, payload) => {
        this.channelFor(client).routeReadError(payload);
      },
    };
  }

  /**
   * Return the {@link WsPushChannel} for this client (lazily created).
   * Consumed by the download service to build a {@link WsRequestContext}
   * for fetchr-push registrations.
   */
  channelFor(client: WsClient): WsPushChannel {
    let channel = this.channels.get(client);
    if (!channel) {
      channel = new WsPushChannel((topic, payload) => this.transport.unicast(client, topic, payload));
      this.channels.set(client, channel);
    }
    return channel;
  }

  onBinaryEvent(client: WsClient, buf: Buffer): void {
    const frame = decodePushChunk(buf);
    if (!frame) {
      return;
    }
    this.channelFor(client).routeBinary(frame);
  }

  onDisconnected(client: WsClient): void {
    super.onDisconnected(client);
    const channel = this.channels.get(client);
    if (channel) {
      channel.markClosed('WS disconnected');
      this.channels.delete(client);
    }
  }
}
