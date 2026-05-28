import { ConfigService } from '@nestjs/config';

import { Config } from '@/app.module';
import { HealthService } from '@/modules/health/health.service';
import { PluginRegistry } from '@/plugins/plugin-registry';
import { DownloadEngine } from '@/services/download-engine';
import { DownloadEventEmitter } from '@/services/download-events';
import { StateStore } from '@/services/state-store';

export const stateStoreProvider = {
  provide: StateStore,
  useFactory: (configService: ConfigService<Config, true>, health: HealthService): StateStore => {
    return new StateStore(configService.get('downloadsPath'), health);
  },
  inject: [ConfigService, HealthService],
};

export const downloadEngineProvider = {
  provide: DownloadEngine,
  useFactory: (
    registry: PluginRegistry,
    eventEmitter: DownloadEventEmitter,
    stateStore: StateStore,
    configService: ConfigService<Config, true>,
  ): DownloadEngine => {
    return new DownloadEngine(
      registry,
      eventEmitter,
      stateStore,
      configService.get('downloadsPath'),
      configService.get('maxConcurrentDownloads'),
    );
  },
  inject: [PluginRegistry, DownloadEventEmitter, StateStore, ConfigService],
};
