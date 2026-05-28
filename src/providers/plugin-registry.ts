import { ConfigService } from '@nestjs/config';

import { Config } from '@/app.module';
import { loadArchivePlugins, loadHostPlugins } from '@/plugins/plugin-loader';
import { PluginRegistry } from '@/plugins/plugin-registry';
import { PushSessionManager } from '@/services/push-session-manager';

export const pluginRegistryProvider = {
  provide: PluginRegistry,
  useFactory: async (
    configService: ConfigService<Config, true>,
    pushSessionManager: PushSessionManager,
  ): Promise<PluginRegistry> => {
    const hostNames = configService.get('hostPlugins');
    const archiveNames = configService.get('archivePlugins');

    const hosts = await loadHostPlugins(hostNames, {
      env: process.env as Record<string, string | undefined>,
      pushSessionManager,
    });
    const archives = await loadArchivePlugins(archiveNames);

    return new PluginRegistry(hosts, archives);
  },
  inject: [ConfigService, PushSessionManager],
};
