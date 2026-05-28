import { INestApplication, Logger } from '@nestjs/common';

const log = new Logger('Shutdown');

const DEFAULT_TIMEOUT_MS = 20000;

export type ShutdownOptions = {
  timeoutMs?: number;
  beforeClose?: () => Promise<void> | void;
  onUncaught?: (kind: 'unhandledRejection' | 'uncaughtException', err: unknown) => void;
};

export function installShutdownHandlers(app: INestApplication, opts: ShutdownOptions = {}): void {
  const timeoutMs = opts.timeoutMs ?? Number(process.env.SHUTDOWN_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  let shuttingDown = false;

  const shutdown = async (signal: string, code = 0): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    log.log(`Received ${signal}, draining (timeout ${timeoutMs}ms)`);
    const force = setTimeout(() => {
      log.error(`Drain exceeded ${timeoutMs}ms, forcing exit`);
      process.exit(code || 1);
    }, timeoutMs);
    force.unref();
    try {
      if (opts.beforeClose) {
        await opts.beforeClose();
      }
      await app.close();
    } catch (err) {
      log.error(`app.close() failed: ${(err as Error).message}`);
    }
    clearTimeout(force);
    process.exit(code);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    const err = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
    log.error(`unhandledRejection: ${err}`);
    if (opts.onUncaught) {
      opts.onUncaught('unhandledRejection', reason);
    }
    void shutdown('unhandledRejection', 1);
  });
  process.on('uncaughtException', (err) => {
    log.error(`uncaughtException: ${err.stack ?? err.message}`);
    if (opts.onUncaught) {
      opts.onUncaught('uncaughtException', err);
    }
    void shutdown('uncaughtException', 1);
  });
}
