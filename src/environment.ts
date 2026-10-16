import { z } from 'zod';

import { logger } from '@/services/logger';

const commaSeparatedList = z.string().transform((s) =>
  s
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean),
);

export const environmentVariablesSchema = z
  .object({
    LOG_LEVEL: z.string().optional(),
    PORT: z.coerce.number().optional(),
    APP_VERSION: z.string().default('dev'),
    API_KEY: z.string(),
    DOWNLOADS_PATH: z.string(),
    MAX_CONCURRENT_DOWNLOADS: z.coerce.number().int().min(1).optional(),
    HOST_PLUGINS: commaSeparatedList,
    ARCHIVE_PLUGINS: commaSeparatedList.optional(),
  })
  .transform((env) => ({
    server: {
      port: env.PORT ?? 3000,
      apiKey: env.API_KEY,
      logLevel: env.LOG_LEVEL,
      version: env.APP_VERSION,
    },
    downloadsPath: env.DOWNLOADS_PATH,
    maxConcurrentDownloads: env.MAX_CONCURRENT_DOWNLOADS ?? 3,
    hostPlugins: env.HOST_PLUGINS,
    archivePlugins: env.ARCHIVE_PLUGINS ?? [],
  }));

export type EnvironmentVariables = z.infer<typeof environmentVariablesSchema>;

export function loadEnv(): EnvironmentVariables {
  const config = environmentVariablesSchema.parse(process.env);
  logger.debug(`Parsed environment variables ${JSON.stringify(config, null, 2)}`);
  return config;
}
