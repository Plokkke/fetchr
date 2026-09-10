import { Logger } from '@nestjs/common';
import { z } from 'zod';

import { Gateway, HandlerMap, WsClient } from '@/gateways/protocols/gateway';

Logger.overrideLogger(false);

const eventSchema = z.discriminatedUnion('topic', [
  z.object({ topic: z.literal('echo'), payload: z.object({ value: z.string() }) }),
  z.object({ topic: z.literal('boom'), payload: z.object({}) }),
]);
type Event = z.infer<typeof eventSchema>;

class EchoGateway extends Gateway<Event> {
  protected readonly logger = new Logger('EchoGateway');
  protected readonly eventSchema = eventSchema;
  protected readonly eventHandlers: HandlerMap<Event> = {
    echo: (_client, payload) => ({ echoed: payload.value }),
    boom: () => {
      throw new Error('kaboom');
    },
  };
}

class MuteGateway extends Gateway {
  protected readonly logger = new Logger('MuteGateway');
}

const client = {} as WsClient;

describe('Gateway.onTextEvent', () => {
  it('resolves with the handler result so the router can ack it', async () => {
    await expect(new EchoGateway().onTextEvent(client, { topic: 'echo', payload: { value: 'hi' } })).resolves.toEqual({
      echoed: 'hi',
    });
  });

  it('rejects an invalid payload instead of swallowing it', async () => {
    await expect(new EchoGateway().onTextEvent(client, { topic: 'echo', payload: { value: 1 } })).rejects.toThrow(
      /Invalid client event/,
    );
  });

  it('propagates handler failures', async () => {
    await expect(new EchoGateway().onTextEvent(client, { topic: 'boom', payload: {} })).rejects.toThrow('kaboom');
  });

  it('rejects uplink events on a scope without handlers', async () => {
    await expect(new MuteGateway().onTextEvent(client, { topic: 'x', payload: {} })).rejects.toThrow(
      /accepts no client events/,
    );
  });
});
