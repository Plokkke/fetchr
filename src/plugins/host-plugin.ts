import { Readable } from 'stream';

import { DownloadItem } from '@/schemas/DownloadItem';
import { RequestContext } from '@/services/request-context';

export type FileInfo = {
  fileName: string;
  size: number | null;
  /** Strong validator of the remote file when the host exposes one (HTTP ETag). */
  etag?: string | null;
  /** Content hash advertised by the host, kept for a last-resort integrity check. */
  checksum?: string | null;
};

export type OpenOptions = {
  /** Byte offset the engine would like the stream to start at. */
  from: number;
  /** ETag recorded on a previous open, sent as `If-Range` so a changed file restarts from 0. */
  etag?: string | null;
};

export type OpenedStream = {
  stream: Readable;
  /** Offset the host actually honoured: `options.from`, or 0 when it served the whole file. */
  from: number;
  etag?: string | null;
};

export interface ResolvedSource {
  readonly infos: FileInfo;
  open(options: OpenOptions): Promise<OpenedStream>;
  close?(): Promise<void>;
}

export interface HostPlugin {
  readonly name: string;
  readonly urlPattern: string;
  canHandle(url: string): boolean;
  resolve(item: DownloadItem, ctx?: RequestContext): Promise<ResolvedSource>;
}
