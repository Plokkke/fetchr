import * as fs from 'node:fs';
import * as path from 'node:path';
import { Transform } from 'stream';
import { pipeline } from 'stream/promises';

import { ArchivePlugin } from '@/plugins/archive-plugin';

/** Extracts every entry of the archive under `targetDir`, reporting the overall ratio written. */
export async function extractArchive(
  plugin: ArchivePlugin,
  archivePath: string,
  targetDir: string,
  onProgress: (ratio: number) => void,
): Promise<string[]> {
  fs.mkdirSync(targetDir, { recursive: true });
  const result = await plugin.extract(archivePath);
  let bytesWritten = 0;
  const filePaths: string[] = [];

  for await (const file of result.files) {
    const targetPath = path.join(targetDir, file.name);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });

    const tracker = new Transform({
      transform: (chunk: Buffer, _encoding, callback) => {
        bytesWritten += chunk.length;
        if (result.totalSize > 0) {
          onProgress(bytesWritten / result.totalSize);
        }
        callback(null, chunk);
      },
    });

    await pipeline(file.stream, tracker, fs.createWriteStream(targetPath));
    filePaths.push(targetPath);
  }

  return filePaths;
}
