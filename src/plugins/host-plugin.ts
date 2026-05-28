import { Readable } from 'stream';

import { DownloadItem } from '@/schemas/DownloadItem';
import { RequestContext } from '@/services/request-context';

export type FileInfo = {
  fileName: string;
  size: number | null;
};

export interface ResolvedSource {
  readonly infos: FileInfo;
  open(): Promise<Readable>;
  close?(): Promise<void>;
}

export interface HostPlugin {
  readonly name: string;
  readonly urlPattern: string;
  canHandle(url: string): boolean;
  resolve(item: DownloadItem, ctx?: RequestContext): Promise<ResolvedSource>;
}
