import { Logger } from '@nestjs/common';
import axios, { AxiosError, AxiosResponse } from 'axios';
import { z } from 'zod';

import { FileInfo, HostPlugin, OpenedStream, OpenOptions, ResolvedSource } from '@/plugins/host-plugin';
import { headerEtag, openHttpStream } from '@/plugins/http-range';
import { DownloadItem } from '@/schemas/DownloadItem';

export const oneFichierConfigSchema = z.object({
  host: z.string().trim().min(1),
  apiKey: z.string().trim().min(1).optional(),
});

export type OneFichierConfig = z.infer<typeof oneFichierConfigSchema>;

const WEB_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 6.1; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/48.0.2564.103 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-us,en;q=0.5',
  Cookie: 'LG=en',
};

const FREE_DOWNLOAD_WAIT_MS = 2000;

function cleanUrl(url: string): string {
  return url.replace(/[&?]af=\d+/g, '');
}

export class OneFichierError extends Error {
  constructor(
    message: string,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'OneFichierError';
  }
}

function getFileName(response: AxiosResponse): string {
  const contentDisposition = response.headers['content-disposition'];
  if (!contentDisposition) {
    return '';
  }
  const match = contentDisposition.match(/filename="?([^";]+)"?/);
  return match ? match[1] : '';
}

function getContentLength(response: AxiosResponse): number | null {
  const length = response.headers['content-length'];
  return length ? parseInt(length, 10) : null;
}

function parseFileSize(sizeStr: string): number | null {
  const match = sizeStr.trim().match(/([\d.,]+)\s*([KMGT]?)(o|b)/i);
  if (!match) {
    return null;
  }
  const value = parseFloat(match[1].replace(',', '.'));
  const unit = match[2].toUpperCase();
  const multipliers: Record<string, number> = { '': 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 };
  return Math.round(value * (multipliers[unit] ?? 1));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function detectErrors(html: string): void {
  if (/File not found/i.test(html) || /NOT FOUND/i.test(html) || /BAD LINK/i.test(html)) {
    throw new OneFichierError('File not found on 1fichier');
  }
  if (/IP Locked/i.test(html)) {
    throw new OneFichierError('IP locked by 1fichier', 60 * 60 * 1000);
  }
  const waitMatch = html.match(/You must wait (?:at least|up to)\s*(\d+)\s*minutes/i);
  if (waitMatch) {
    const waitMinutes = parseInt(waitMatch[1], 10);
    throw new OneFichierError(`Must wait ${waitMinutes} minutes`, waitMinutes * 60 * 1000);
  }
  if (/Your requests are too fast/i.test(html)) {
    throw new OneFichierError('Requests too fast, slow down', 30 * 1000);
  }
  if (/You already download/i.test(html) || /download only one file at a time/i.test(html)) {
    throw new OneFichierError('Concurrent download limit reached', 30 * 1000);
  }
  if (/Access to this file is protected/i.test(html) || /PRIVATE/i.test(html)) {
    throw new OneFichierError('File is private or access restricted');
  }
  if (/too many connections/i.test(html) || /massively shared/i.test(html)) {
    throw new OneFichierError('Too many connections detected', 5 * 60 * 1000);
  }
}

function extractDownloadLink(html: string): string | null {
  const patterns = [
    /<a\s+href="(https?:\/\/[^"]+)"[^>]*>.*?Click here to download/is,
    /window\.location\s*=\s*['"]?(https?:\/\/[^'";\s]+)/i,
    /align:middle">\s*<a\s+href=['"]?(https?:\/\/[^'";\s]+)/i,
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) {
      return match[1];
    }
  }
  return null;
}

export class OneFichierHostPlugin implements HostPlugin {
  readonly name = 'one-fichier';
  readonly urlPattern: string;
  private readonly logger = new Logger(OneFichierHostPlugin.name);
  private readonly isPremium: boolean;
  private readonly urlRegex: RegExp;

  constructor(private readonly config: OneFichierConfig) {
    this.isPremium = !!config.apiKey;
    const escapedHost = config.host.replace(/\./g, '\\.');
    // Share URLs (https://1fichier.com/?id) OR direct mirror URLs (https://a-10.1fichier.com/path).
    this.urlPattern = `https?://(?:[\\w.-]+\\.)?${escapedHost}/\\?\\w+|https?://[\\w-]+\\.${escapedHost}/\\w+`;
    this.urlRegex = new RegExp(this.urlPattern);
    this.logger.log(`1Fichier plugin initialized in ${this.isPremium ? 'premium' : 'free'} mode`);
  }

  canHandle(url: string): boolean {
    return this.urlRegex.test(url);
  }

  async resolve(item: DownloadItem): Promise<ResolvedSource> {
    const url = item.url;
    const clean = cleanUrl(url);

    if (this.isDirectUrl(clean)) {
      this.logger.log(`Resolving ${url} (direct mirror, streaming as-is)`);
      const infos = await this.fetchDirectFileInfo(clean);
      return { infos, open: (options) => openHttpStream(clean, options) };
    }

    this.logger.log(`Resolving ${url} (${this.isPremium ? 'premium' : 'free'} mode)`);
    const infos = await this.fetchFileInfo(clean);
    return {
      infos,
      open: (options) => this.openStream(clean, options),
    };
  }

  private isDirectUrl(url: string): boolean {
    try {
      const parsed = new URL(url);
      const host = this.config.host;
      return parsed.hostname !== host && parsed.hostname.endsWith(`.${host}`) && parsed.pathname.length > 1;
    } catch {
      return false;
    }
  }

  private async fetchDirectFileInfo(url: string): Promise<FileInfo> {
    try {
      const response = await axios.head(url);
      const fileName = getFileName(response) || (url.split('/').pop() ?? '') || 'unknown';
      return { fileName, size: getContentLength(response), etag: headerEtag(response) };
    } catch (error) {
      this.logger.warn(`HEAD failed on direct URL: ${error instanceof Error ? error.message : error}`);
      return { fileName: url.split('/').pop() || 'unknown', size: null };
    }
  }

  private async fetchFileInfo(url: string): Promise<FileInfo> {
    if (this.isPremium) {
      try {
        const response = await axios.post(
          `https://api.${this.config.host}/v1/file/info.cgi`,
          { url },
          {
            headers: {
              Authorization: `Bearer ${this.config.apiKey}`,
              'Content-Type': 'application/json',
            },
          },
        );

        if (response.data?.filename) {
          return {
            fileName: response.data.filename,
            size: response.data.size ?? null,
            checksum: response.data.checksum ?? null,
          };
        }

        this.logger.warn(`API file/info: no filename in response`);
      } catch (error) {
        this.logger.warn(
          `API file/info failed, falling back to page: ${error instanceof Error ? error.message : error}`,
        );
      }
    }

    return this.fetchFileInfoFromPage(url);
  }

  private async fetchFileInfoFromPage(url: string): Promise<FileInfo> {
    const response = await axios.get(url, { headers: WEB_HEADERS });
    const html = response.data as string;
    detectErrors(html);

    const fileNameMatch =
      html.match(/font-weight:\s*bold[^>]*>([^<]+\.\w{2,5})</i) ??
      html.match(/File\s*name\s*:\s*([^<\n]+)/i) ??
      html.match(/class="ok"[^>]*>([^<]+)/i);
    const sizeMatch =
      html.match(/font-style:\s*italic[^>]*>([\d.,]+\s*[KMGT]?[Bo])\s*</i) ?? html.match(/([\d.,]+\s*[KMGT][Bo])\b/i);

    const fileName = fileNameMatch?.[1]?.trim() ?? url.split('?')[1] ?? 'unknown';
    const size = sizeMatch ? parseFileSize(sizeMatch[1]) : null;

    return { fileName, size };
  }

  private async openStream(url: string, options: OpenOptions): Promise<OpenedStream> {
    const downloadUrl = await this.resolveDownloadUrl(url);
    const opened = await openHttpStream(downloadUrl, options);
    this.logger.debug(`Stream opened from offset ${opened.from} (asked ${options.from})`);
    return opened;
  }

  private async resolveDownloadUrl(url: string): Promise<string> {
    return this.isPremium ? this.resolveDownloadUrlPremium(url) : this.resolveDownloadUrlFree(url);
  }

  private async resolveDownloadUrlPremium(url: string): Promise<string> {
    const response = await axios
      .post(
        `https://api.${this.config.host}/v1/download/get_token.cgi`,
        { url },
        {
          headers: {
            Authorization: `Bearer ${this.config.apiKey}`,
            'Content-Type': 'application/json',
          },
        },
      )
      .catch((error: AxiosError) => {
        const data = error.response?.data as Record<string, string> | undefined;
        const message = data?.message ?? error.message;
        if (error.response?.status === 403) {
          throw new OneFichierError(`1fichier API access denied: ${message}`, 15 * 60 * 1000);
        }
        throw new OneFichierError(`1fichier API error: ${message}`);
      });

    if (response.data.status !== 'OK') {
      throw new OneFichierError(`1fichier API error: ${response.data.message ?? JSON.stringify(response.data)}`);
    }
    return response.data.url;
  }

  private async resolveDownloadUrlFree(url: string): Promise<string> {
    const pageResponse = await axios.get(url, { headers: WEB_HEADERS, maxRedirects: 0 }).catch((error: AxiosError) => {
      if (error.response?.status === 404) {
        throw new OneFichierError('File not found on 1fichier');
      }
      if (error.response?.status === 503) {
        throw new OneFichierError('1fichier is under maintenance', 20 * 60 * 1000);
      }
      throw error;
    });

    detectErrors(pageResponse.data as string);
    this.logger.debug('Waiting for free download timer...');
    await sleep(FREE_DOWNLOAD_WAIT_MS);

    const postResponse = await axios.post(url, '', {
      headers: { ...WEB_HEADERS, 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    detectErrors(postResponse.data as string);
    const downloadLink = extractDownloadLink(postResponse.data as string);
    if (!downloadLink) {
      throw new OneFichierError('Could not extract download link from 1fichier page');
    }
    return downloadLink;
  }
}
