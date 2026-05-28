import { Injectable, Logger } from '@nestjs/common';

import { Gateway, SubscriptionHandlerMap } from '@/gateways/protocols/gateway';
import { PluginRegistry } from '@/plugins/plugin-registry';

import { SettingsServerTopic } from './topics';

@Injectable()
export class SettingsService extends Gateway {
  protected readonly logger = new Logger(SettingsService.name);
  protected readonly subscriptionHandlers: SubscriptionHandlerMap;

  constructor(private readonly registry: PluginRegistry) {
    super();
    this.subscriptionHandlers = {
      [SettingsServerTopic.Plugins]: (client) => {
        this.transport.unicast(client, SettingsServerTopic.Plugins, {
          hosts: this.registry.hosts.map((h) => ({ name: h.name, urlPattern: h.urlPattern })),
          archives: this.registry.archives.map((a) => a.name),
        });
      },
    };
  }
}
