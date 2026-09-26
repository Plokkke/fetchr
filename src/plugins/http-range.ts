import { Readable } from 'stream';

import axios, { AxiosResponse } from 'axios';

import { OpenedStream, OpenOptions } from '@/plugins/host-plugin';

const CONTENT_RANGE = /^bytes (\d+)-\d+\/(\d+|\*)$/;

export function headerEtag(response: AxiosResponse): string | null {
  const etag = response.headers['etag'];
  return typeof etag === 'string' && etag.length > 0 ? etag : null;
}

/**
 * Opens an HTTP body stream honouring `options.from` through a `Range` request.
 * `If-Range` makes a host whose file changed answer 200 with the whole body,
 * which is reported as `from: 0` so the caller restarts instead of appending.
 */
export async function openHttpStream(url: string, options: OpenOptions): Promise<OpenedStream> {
  const headers: Record<string, string> = {};
  if (options.from > 0) {
    headers.Range = `bytes=${options.from}-`;
    if (options.etag) {
      headers['If-Range'] = options.etag;
    }
  }

  const response = await axios.get(url, {
    responseType: 'stream',
    headers,
    validateStatus: (status) => status === 200 || status === 206,
  });
  const stream = response.data as Readable;
  const etag = headerEtag(response);

  if (response.status === 200) {
    return { stream, from: 0, etag };
  }

  const match = CONTENT_RANGE.exec(String(response.headers['content-range'] ?? ''));
  const start = match ? Number(match[1]) : NaN;
  if (start !== options.from) {
    stream.destroy();
    throw new Error(`host answered 206 from offset ${match ? start : 'unknown'}, expected ${options.from}`);
  }
  return { stream, from: start, etag };
}
