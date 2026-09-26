import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import {
  adoptPartial,
  discardPartial,
  FRESH_START,
  OVERLAP_BYTES,
  OverlapVerifier,
  partPathOf,
  planResume,
  ResumeMismatchError,
} from '@/services/resume';

jest.setTimeout(2000);

function collect(source: Buffer[], expected: Buffer): Promise<Buffer> {
  const input = new PassThrough();
  const output: Buffer[] = [];
  const sink = new PassThrough();
  sink.on('data', (chunk: Buffer) => output.push(chunk));
  const done = pipeline(input, new OverlapVerifier(expected), sink).then(() => Buffer.concat(output));
  source.forEach((chunk) => input.write(chunk));
  input.end();
  return done;
}

describe('OverlapVerifier', () => {
  it('swallows the overlap and passes the rest through, across chunk boundaries', async () => {
    const result = await collect([Buffer.from('abc'), Buffer.from('defXYZ'), Buffer.from('!')], Buffer.from('abcdef'));

    expect(result.toString()).toBe('XYZ!');
  });

  it('passes everything when there is nothing to verify', async () => {
    const result = await collect([Buffer.from('raw')], Buffer.alloc(0));

    expect(result.toString()).toBe('raw');
  });

  it('fails as soon as the host bytes differ from the local tail', async () => {
    await expect(collect([Buffer.from('abX'), Buffer.from('def')], Buffer.from('abcdef'))).rejects.toBeInstanceOf(
      ResumeMismatchError,
    );
  });

  it('fails when the host ends before the whole overlap was served', async () => {
    await expect(collect([Buffer.from('abc')], Buffer.from('abcdef'))).rejects.toThrow(/3 overlap bytes/);
  });
});

describe('partial files', () => {
  let dir: string;
  const filePath = () => path.join(dir, 'movie.mkv');

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fetchr-resume-'));
  });

  it('starts fresh without a partial file', async () => {
    await expect(planResume(partPathOf(filePath()), 100)).resolves.toBe(FRESH_START);
  });

  it('asks for the last overlap again and remembers the local tail', async () => {
    const content = Buffer.alloc(OVERLAP_BYTES + 10, 7);
    content[OVERLAP_BYTES + 9] = 9;
    fs.writeFileSync(partPathOf(filePath()), content);

    const plan = await planResume(partPathOf(filePath()), null);

    expect(plan).toMatchObject({ from: 10, partialSize: OVERLAP_BYTES + 10 });
    expect(plan.expectedTail.equals(content.subarray(10))).toBe(true);
  });

  it('verifies a short partial entirely, starting from 0', async () => {
    fs.writeFileSync(partPathOf(filePath()), 'hello');

    const plan = await planResume(partPathOf(filePath()), 100);

    expect(plan).toMatchObject({ from: 0, partialSize: 5 });
    expect(plan.expectedTail.toString()).toBe('hello');
  });

  it('rejects a partial larger than the remote file', async () => {
    fs.writeFileSync(partPathOf(filePath()), 'too long');

    await expect(planResume(partPathOf(filePath()), 3)).rejects.toBeInstanceOf(ResumeMismatchError);
  });

  it('adopts a leftover complete file as the partial to verify', async () => {
    fs.writeFileSync(filePath(), 'leftover');

    await expect(adoptPartial(filePath())).resolves.toBe(8);

    expect(fs.existsSync(filePath())).toBe(false);
    expect(fs.readFileSync(partPathOf(filePath()), 'utf8')).toBe('leftover');
  });

  it('reports the existing partial size and 0 when nothing is on disk', async () => {
    await expect(adoptPartial(filePath())).resolves.toBe(0);
    fs.writeFileSync(partPathOf(filePath()), 'abc');
    await expect(adoptPartial(filePath())).resolves.toBe(3);
  });

  it('discards both the partial and the final file', async () => {
    fs.writeFileSync(filePath(), 'a');
    fs.writeFileSync(partPathOf(filePath()), 'b');

    discardPartial(filePath());

    expect(fs.readdirSync(dir)).toEqual([]);
  });
});
