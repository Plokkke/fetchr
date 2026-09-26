import { FileInfo } from '@/plugins/host-plugin';
import { DownloadingInfos, DownloadStatus } from '@/schemas/DownloadItem';

function differs<T>(a: T | null | undefined, b: T | null | undefined): boolean {
  return a !== null && a !== undefined && b !== null && b !== undefined && a !== b;
}

/** True when the host now describes another file than the one a partial was taken from. */
export function remoteChanged(previous: DownloadingInfos, next: FileInfo): boolean {
  return (
    previous.fileName !== '' &&
    (previous.fileName !== next.fileName ||
      differs(previous.size, next.size) ||
      differs(previous.etag, next.etag) ||
      differs(previous.checksum, next.checksum))
  );
}

/** Puts a restored item back in the queue, keeping what identifies its partial file. */
export function resetForRequeue(infos: DownloadingInfos, partialBytes: number): void {
  infos.status = DownloadStatus.Queued;
  infos.filePaths = [];
  infos.downloaded = partialBytes;
  infos.progress = infos.size ? partialBytes / infos.size : null;
  infos.speed = 0;
  infos.eta = null;
  infos.error = null;
  infos.downloadedAt = null;
  infos.completedAt = null;
}
