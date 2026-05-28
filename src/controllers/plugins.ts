import { Controller, Get, Logger, UseGuards } from '@nestjs/common';

import { MatchingHeaders } from '@/decorators/MatchingHeaders';
import { MatchingHeadersGuard } from '@/guards/MatchingHeaderGuard';
import { PluginRegistry } from '@/plugins/plugin-registry';

@Controller('/plugins')
@MatchingHeaders([{ headerKey: 'x-api-key', configPath: 'server.apiKey' }])
@UseGuards(MatchingHeadersGuard)
export class PluginsController {
  private readonly logger = new Logger(PluginsController.name);

  constructor(private readonly registry: PluginRegistry) {}

  @Get('/')
  getPlugins(): { hosts: { name: string; urlPattern: string }[]; archives: string[] } {
    return {
      hosts: this.registry.hosts.map((h) => ({ name: h.name, urlPattern: h.urlPattern })),
      archives: this.registry.archives.map((a) => a.name),
    };
  }
}
