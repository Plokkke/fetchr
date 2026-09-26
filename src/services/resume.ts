import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import { Transform, TransformCallback } from 'stream';

/** Bytes re-downloaded and compared against the local tail before appending. */
export const OVERLAP_BYTES = 1024 * 1024;

export class ResumeMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResumeMismatchError';
  }
}

export type ResumePlan = {
  /** Offset to request from the host. */
  from: number;
  /** Bytes already on disk; the write head after the overlap is verified. */
  partialSize: number;
  /** Local tail that must match the first bytes served from `from`. */
  expectedTail: Buffer;
};

export const FRESH_START: ResumePlan = { from: 0, partialSize: 0, expectedTail: Buffer.alloc(0) };

export function partPathOf(filePath: string): string {
  return `${filePath}.part`;
}

/**
 * Builds a plan from the partial file: ask the host for the last `OVERLAP_BYTES`
 * again so the engine can prove the local tail is intact before appending.
 */
export async function planResume(partPath: string, expectedSize: number | null): Promise<ResumePlan> {
  const stat = await fsp.stat(partPath).catch(() => null);
  if (!stat || stat.size === 0) {
    return FRESH_START;
  }
  if (expectedSize !== null && stat.size > expectedSize) {
    throw new ResumeMismatchError(`partial file is larger than the remote file (${stat.size} > ${expectedSize})`);
  }

  const overlap = Math.min(OVERLAP_BYTES, stat.size);
  const from = stat.size - overlap;
  const expectedTail = await readRange(partPath, from, overlap);
  return { from, partialSize: stat.size, expectedTail };
}

async function readRange(filePath: string, position: number, length: number): Promise<Buffer> {
  const handle = await fsp.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, position);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * Swallows the first `expected.length` bytes of the stream, failing the pipeline
 * if they differ from the local tail, then passes everything else through.
 */
export class OverlapVerifier extends Transform {
  private matched = 0;

  constructor(private readonly expected: Buffer) {
    super();
  }

  _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    const pending = this.expected.length - this.matched;
    if (pending <= 0) {
      callback(null, chunk);
      return;
    }

    const take = Math.min(chunk.length, pending);
    if (!chunk.subarray(0, take).equals(this.expected.subarray(this.matched, this.matched + take))) {
      callback(new ResumeMismatchError(`local tail differs from the host at offset ${this.matched}`));
      return;
    }

    this.matched += take;
    const rest = chunk.subarray(take);
    callback(null, rest.length > 0 ? rest : undefined);
  }

  _flush(callback: TransformCallback): void {
    if (this.matched < this.expected.length) {
      callback(new ResumeMismatchError(`host sent ${this.matched} overlap bytes, expected ${this.expected.length}`));
      return;
    }
    callback();
  }
}

export function openPartForWrite(partPath: string, plan: ResumePlan): fs.WriteStream {
  return fs.createWriteStream(partPath, { flags: plan.partialSize > 0 ? 'a' : 'w' });
}

/**
 * Makes a leftover complete file resumable: it becomes the partial whose tail
 * gets verified against the host, so a stale file never passes unverified.
 * Returns the number of bytes now held by the partial file.
 */
export async function adoptPartial(filePath: string): Promise<number> {
  const partPath = partPathOf(filePath);
  const part = await fsp.stat(partPath).catch(() => null);
  if (part) {
    return part.size;
  }
  const final = await fsp.stat(filePath).catch(() => null);
  if (!final || !final.isFile()) {
    return 0;
  }
  await fsp.rename(filePath, partPath);
  return final.size;
}

export function discardPartial(filePath: string): void {
  [partPathOf(filePath), filePath].forEach((p) => fs.rmSync(p, { force: true }));
}
