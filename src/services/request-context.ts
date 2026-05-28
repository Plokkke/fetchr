import { PushChannel } from '@/gateways/protocols/upload/push-channel';

export abstract class RequestContext {}

export class WsRequestContext extends RequestContext {
  constructor(public readonly pushChannel: PushChannel) {
    super();
  }
}
