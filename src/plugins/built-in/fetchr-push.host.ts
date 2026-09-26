import { Logger } from '@nestjs/common';

import { HostPlugin, ResolvedSource } from '@/plugins/host-plugin';
import { DownloadItem } from '@/schemas/DownloadItem';
import { PushSessionManager } from '@/services/push-session-manager';
import { RequestContext, WsRequestContext } from '@/services/request-context';

const URL_PATTERN = 'fetchr-push://[0-9a-f-]+';
const URL_REGEX = /^fetchr-push:\/\/([0-9a-f-]+)$/;

function parseToken(url: string): string {
  const match = url.match(URL_REGEX);
  if (!match) {
    throw new Error(`Invalid fetchr-push URL: ${url}`);
  }
  return match[1];
}

function parseMetadata(metadata?: Record<string, string>): { fileName: string; size: number } {
  if (!metadata) {
    throw new Error('fetchr-push requires metadata with fileName and size');
  }
  const fileName = metadata.fileName?.trim();
  const sizeStr = metadata.size;
  if (!fileName) {
    throw new Error('fetchr-push metadata.fileName is required and must be non-empty');
  }
  if (sizeStr === undefined) {
    throw new Error('fetchr-push metadata.size is required');
  }
  const size = Number.parseInt(sizeStr, 10);
  if (!Number.isFinite(size) || size < 0) {
    throw new Error(`fetchr-push metadata.size must be a non-negative integer, got ${sizeStr}`);
  }
  return { fileName, size };
}

export class FetchrPushHostPlugin implements HostPlugin {
  readonly name = 'fetchr-push';
  readonly urlPattern = URL_PATTERN;
  private readonly logger = new Logger(FetchrPushHostPlugin.name);

  constructor(private readonly manager: PushSessionManager) {}

  canHandle(url: string): boolean {
    return URL_REGEX.test(url);
  }

  async resolve(item: DownloadItem, ctx?: RequestContext): Promise<ResolvedSource> {
    if (!(ctx instanceof WsRequestContext)) {
      throw new Error('fetchr-push requires WebSocket transport (register via WS)');
    }

    const token = parseToken(item.url);
    const { fileName, size } = parseMetadata(item.metadata);

    this.manager.bind(token, ctx.pushChannel, { fileName, size });
    this.logger.log(`Resolved push session ${token}: ${fileName} (${size} bytes)`);

    return {
      infos: { fileName, size },
      open: async () => ({ stream: this.manager.openReadStream(token), from: 0 }),
      close: async () => this.manager.close(token),
    };
  }
}
