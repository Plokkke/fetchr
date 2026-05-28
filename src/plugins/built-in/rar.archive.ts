import { Readable } from 'stream';

import { Logger } from '@nestjs/common';
import { RARExtractor } from 'unrar-async';

import { ArchivePlugin, ExtractedFile, ExtractionResult } from '@/plugins/archive-plugin';

const RAR4_MAGIC = Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]);
const RAR5_MAGIC = Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00]);

export class RarArchivePlugin implements ArchivePlugin {
  readonly name = 'rar';
  private readonly logger = new Logger(RarArchivePlugin.name);

  canHandle(header: Buffer): boolean {
    if (header.length < 7) {
      return false;
    }
    return header.subarray(0, 7).equals(RAR4_MAGIC) || (header.length >= 8 && header.subarray(0, 8).equals(RAR5_MAGIC));
  }

  async extract(filePath: string): Promise<ExtractionResult> {
    const extractor = await RARExtractor.fromFile(filePath);
    const { totalSize, files } = await extractor.extract();

    this.logger.log(`RAR archive: ${(totalSize / 1024 / 1024).toFixed(1)} MB total`);

    return {
      totalSize,
      files: this.mapFiles(files, extractor),
    };
  }

  private async *mapFiles(
    files: AsyncIterable<{
      fileHeader: { name: string; unpSize: number; flags: { directory: boolean } };
      extraction?: Readable;
    }>,
    extractor: RARExtractor,
  ): AsyncIterable<ExtractedFile> {
    try {
      for await (const { fileHeader, extraction } of files) {
        if (fileHeader.flags.directory || !extraction) {
          continue;
        }
        yield {
          name: fileHeader.name,
          size: fileHeader.unpSize,
          stream: extraction,
        };
      }
    } finally {
      extractor.close();
    }
  }
}
