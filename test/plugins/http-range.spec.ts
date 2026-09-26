import { PassThrough } from 'node:stream';

import axios, { AxiosResponse } from 'axios';

import { openHttpStream } from '@/plugins/http-range';

function response(status: number, headers: Record<string, string> = {}): AxiosResponse<PassThrough> {
  return {
    data: new PassThrough(),
    headers,
    status,
    statusText: '',
    config: {},
  } as unknown as AxiosResponse<PassThrough>;
}

afterEach(() => jest.restoreAllMocks());

describe('openHttpStream', () => {
  it('sends no Range header when starting from 0', async () => {
    const get = jest.spyOn(axios, 'get').mockResolvedValueOnce(response(200, { etag: '"e1"' }));

    const opened = await openHttpStream('https://cdn.test/f', { from: 0 });

    expect(opened).toMatchObject({ from: 0, etag: '"e1"' });
    expect(get).toHaveBeenCalledWith('https://cdn.test/f', expect.objectContaining({ headers: {} }));
  });

  it('asks for the offset with If-Range and honours a matching 206', async () => {
    const get = jest
      .spyOn(axios, 'get')
      .mockResolvedValueOnce(response(206, { 'content-range': 'bytes 500-999/1000', etag: '"e1"' }));

    const opened = await openHttpStream('https://cdn.test/f', { from: 500, etag: '"e1"' });

    expect(opened.from).toBe(500);
    expect(get).toHaveBeenCalledWith(
      'https://cdn.test/f',
      expect.objectContaining({ headers: { Range: 'bytes=500-', 'If-Range': '"e1"' } }),
    );
  });

  it('reports a full-body 200 as a restart from 0', async () => {
    jest.spyOn(axios, 'get').mockResolvedValueOnce(response(200, { etag: '"e2"' }));

    const opened = await openHttpStream('https://cdn.test/f', { from: 500, etag: '"e1"' });

    expect(opened).toMatchObject({ from: 0, etag: '"e2"' });
  });

  it('refuses a 206 that starts elsewhere than requested', async () => {
    const res = response(206, { 'content-range': 'bytes 0-999/1000' });
    jest.spyOn(axios, 'get').mockResolvedValueOnce(res);

    await expect(openHttpStream('https://cdn.test/f', { from: 500 })).rejects.toThrow(/from offset 0, expected 500/);
    expect(res.data.destroyed).toBe(true);
  });

  it('lets only 200 and 206 through the status filter', async () => {
    const get = jest.spyOn(axios, 'get').mockResolvedValueOnce(response(206, { 'content-range': 'bytes 1-1/2' }));

    await openHttpStream('https://cdn.test/f', { from: 1 });

    const { validateStatus } = get.mock.calls[0][1] as { validateStatus: (s: number) => boolean };
    expect([200, 206, 416, 404].map(validateStatus)).toEqual([true, true, false, false]);
  });
});
