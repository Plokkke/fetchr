import { Logger } from '@nestjs/common';

import { ArchivePlugin } from '@/plugins/archive-plugin';
import { FetchrPushHostPlugin } from '@/plugins/built-in/fetchr-push.host';
import { OneFichierHostPlugin } from '@/plugins/built-in/one-fichier.host';
import { RarArchivePlugin } from '@/plugins/built-in/rar.archive';
import { ZipArchivePlugin } from '@/plugins/built-in/zip.archive';
import { HostPlugin } from '@/plugins/host-plugin';
import { PushSessionManager } from '@/services/push-session-manager';

const logger = new Logger('PluginLoader');

export type HostPluginContext = {
  env: Record<string, string | undefined>;
  pushSessionManager: PushSessionManager;
};

type BuiltInHostFactory = (ctx: HostPluginContext) => HostPlugin;
type BuiltInArchiveFactory = () => ArchivePlugin;

const BUILT_IN_HOSTS: Record<string, BuiltInHostFactory> = {
  'one-fichier': ({ env }) => {
    const host = env.ONE_FICHIER_HOST;
    if (!host) {
      throw new Error('Plugin one-fichier requires ONE_FICHIER_HOST environment variable');
    }
    return new OneFichierHostPlugin({ host, apiKey: env.ONE_FICHIER_API_KEY });
  },
  'fetchr-push': ({ pushSessionManager }) => new FetchrPushHostPlugin(pushSessionManager),
};

const BUILT_IN_ARCHIVES: Record<string, BuiltInArchiveFactory> = {
  zip: () => new ZipArchivePlugin(),
  rar: () => new RarArchivePlugin(),
};

async function loadExternalPlugin<T>(packageName: string): Promise<T> {
  logger.log(`Loading external plugin: ${packageName}`);
  const module = await import(packageName);
  const factory = module.default;
  if (typeof factory !== 'function') {
    throw new Error(`Plugin ${packageName} must export a default factory function`);
  }
  return factory() as T;
}

export async function loadHostPlugins(names: string[], ctx: HostPluginContext): Promise<HostPlugin[]> {
  const plugins: HostPlugin[] = [];

  for (const name of names) {
    const builtIn = BUILT_IN_HOSTS[name];
    if (builtIn) {
      plugins.push(builtIn(ctx));
      logger.log(`Loaded built-in host plugin: ${name}`);
    } else {
      plugins.push(await loadExternalPlugin<HostPlugin>(name));
      logger.log(`Loaded external host plugin: ${name}`);
    }
  }

  if (plugins.length === 0) {
    throw new Error('No host plugins loaded. At least one host plugin is required (HOST_PLUGINS)');
  }

  return plugins;
}

export async function loadArchivePlugins(names: string[]): Promise<ArchivePlugin[]> {
  const plugins: ArchivePlugin[] = [];

  for (const name of names) {
    const builtIn = BUILT_IN_ARCHIVES[name];
    if (builtIn) {
      plugins.push(builtIn());
      logger.log(`Loaded built-in archive plugin: ${name}`);
    } else {
      const plugin = await loadExternalPlugin<ArchivePlugin>(name);
      plugins.push(plugin);
      logger.log(`Loaded external archive plugin: ${name}`);
    }
  }

  return plugins;
}
