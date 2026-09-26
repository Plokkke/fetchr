import { Transform } from 'stream';

import { DownloadingInfos } from '@/schemas/DownloadItem';

const SPEED_WINDOW_MS = 5000;

export type SpeedSample = { timestamp: number; bytes: number };

function computeSpeed(samples: SpeedSample[]): number {
  const now = Date.now();
  const recent = samples.filter((s) => now - s.timestamp < SPEED_WINDOW_MS);
  if (recent.length < 2) {
    return 0;
  }
  const totalBytes = recent.reduce((sum, s) => sum + s.bytes, 0);
  const elapsed = (now - recent[0].timestamp) / 1000;
  return elapsed > 0 ? totalBytes / elapsed : 0;
}

function computeEta(size: number | null, downloaded: number, speed: number): number | null {
  if (!size || speed <= 0) {
    return null;
  }
  return Math.round((size - downloaded) / speed);
}

/** Pass-through that keeps `infos` (downloaded, speed, eta, progress) current for every chunk. */
export function progressTracker(
  infos: DownloadingInfos,
  samples: { current: SpeedSample[] },
  onChunk: () => void,
): Transform {
  return new Transform({
    transform: (chunk: Buffer, _encoding, callback) => {
      infos.downloaded += chunk.length;
      const now = Date.now();
      samples.current = [
        ...samples.current.filter((s) => now - s.timestamp < SPEED_WINDOW_MS),
        { timestamp: now, bytes: chunk.length },
      ];

      infos.speed = computeSpeed(samples.current);
      infos.eta = computeEta(infos.size, infos.downloaded, infos.speed);
      if (infos.size) {
        infos.progress = infos.downloaded / infos.size;
      }

      onChunk();
      callback(null, chunk);
    },
  });
}
