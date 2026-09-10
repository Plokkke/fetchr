import { Logger } from '@nestjs/common';
import axios, { AxiosError, AxiosResponse } from 'axios';

import { OneFichierError, OneFichierHostPlugin } from '@/plugins/built-in/one-fichier.host';

Logger.overrideLogger(false);

const HOST = '1fichier.com';
const SHARE_URL = `https://${HOST}/?abc123`;

function response<T>(data: T, headers: Record<string, string> = {}): AxiosResponse<T> {
  return { data, headers, status: 200, statusText: 'OK', config: {} } as unknown as AxiosResponse<T>;
}

function axiosError(status: number, data: unknown): AxiosError {
  return { response: { status, data }, message: `HTTP ${status}` } as unknown as AxiosError;
}

afterEach(() => jest.restoreAllMocks());

describe('OneFichierHostPlugin', () => {
  describe('canHandle', () => {
    const plugin = new OneFichierHostPlugin({ host: HOST });

    it.each([
      ['share link', SHARE_URL, true],
      ['direct mirror', `https://a-10.${HOST}/p123456`, true],
      ['other host', 'https://otherdomain.com/?abc123', false],
    ])('%s', (_label, url, expected) => {
      expect(plugin.canHandle(url)).toBe(expected);
    });
  });

  describe('premium mode', () => {
    const plugin = new OneFichierHostPlugin({ host: HOST, apiKey: 'key' });

    it('reads file infos from the API and opens the tokenised stream', async () => {
      const post = jest
        .spyOn(axios, 'post')
        .mockResolvedValueOnce(response({ filename: 'Movie.mkv', size: 42 }))
        .mockResolvedValueOnce(response({ status: 'OK', url: 'https://cdn.test/movie' }));
      const get = jest.spyOn(axios, 'get').mockResolvedValue(response('stream-body'));

      const resolved = await plugin.resolve({ url: `${SHARE_URL}&af=99` });
      const stream = await resolved.open();

      expect(resolved.infos).toEqual({ fileName: 'Movie.mkv', size: 42 });
      expect(post).toHaveBeenCalledWith(
        `https://api.${HOST}/v1/file/info.cgi`,
        { url: SHARE_URL },
        expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer key' }) }),
      );
      expect(get).toHaveBeenCalledWith('https://cdn.test/movie', { responseType: 'stream' });
      expect(stream).toBe('stream-body');
    });

    it('surfaces an access denial with a retry delay', async () => {
      jest
        .spyOn(axios, 'post')
        .mockResolvedValueOnce(response({ filename: 'Movie.mkv', size: null }))
        .mockRejectedValueOnce(axiosError(403, { message: 'Bad token' }));

      const resolved = await plugin.resolve({ url: SHARE_URL });
      const error = await resolved.open().catch((e: unknown) => e);

      expect(error).toBeInstanceOf(OneFichierError);
      expect(error).toMatchObject({ message: expect.stringContaining('Bad token'), retryAfterMs: 15 * 60 * 1000 });
    });

    it('rejects a token response that is not OK', async () => {
      jest
        .spyOn(axios, 'post')
        .mockResolvedValueOnce(response({ filename: 'Movie.mkv', size: null }))
        .mockResolvedValueOnce(response({ status: 'KO', message: 'Quota exceeded' }));

      const resolved = await plugin.resolve({ url: SHARE_URL });

      await expect(resolved.open()).rejects.toThrow('Quota exceeded');
    });

    it('falls back to the share page when the API gives no filename', async () => {
      jest.spyOn(axios, 'post').mockResolvedValueOnce(response({}));
      jest
        .spyOn(axios, 'get')
        .mockResolvedValueOnce(
          response('<td style="font-weight:bold">Movie.mkv</td><td style="font-style:italic">1.5 GB</td>'),
        );

      const resolved = await plugin.resolve({ url: SHARE_URL });

      expect(resolved.infos).toEqual({ fileName: 'Movie.mkv', size: Math.round(1.5 * 1024 ** 3) });
    });
  });

  describe('free mode', () => {
    const plugin = new OneFichierHostPlugin({ host: HOST });

    it('reports a missing file from the share page', async () => {
      jest.spyOn(axios, 'get').mockResolvedValueOnce(response('<h1>File not found</h1>'));

      await expect(plugin.resolve({ url: SHARE_URL })).rejects.toThrow('File not found on 1fichier');
    });

    it('reports an IP lock with a one hour retry delay', async () => {
      jest.spyOn(axios, 'get').mockResolvedValueOnce(response('IP Locked'));

      const error = await plugin.resolve({ url: SHARE_URL }).catch((e: unknown) => e);

      expect(error).toMatchObject({ retryAfterMs: 60 * 60 * 1000 });
    });
  });

  describe('direct mirror', () => {
    const plugin = new OneFichierHostPlugin({ host: HOST });

    it('takes name and size from a HEAD request and streams the url as-is', async () => {
      const url = `https://a-10.${HOST}/p123456`;
      jest
        .spyOn(axios, 'head')
        .mockResolvedValueOnce(
          response('', { 'content-disposition': 'attachment; filename="Movie.mkv"', 'content-length': '1000' }),
        );
      const get = jest.spyOn(axios, 'get').mockResolvedValueOnce(response('stream-body'));

      const resolved = await plugin.resolve({ url });
      await resolved.open();

      expect(resolved.infos).toEqual({ fileName: 'Movie.mkv', size: 1000 });
      expect(get).toHaveBeenCalledWith(url, { responseType: 'stream' });
    });

    it('falls back to the last path segment when HEAD fails', async () => {
      jest.spyOn(axios, 'head').mockRejectedValueOnce(new Error('nope'));

      const resolved = await plugin.resolve({ url: `https://a-10.${HOST}/p123456` });

      expect(resolved.infos).toEqual({ fileName: 'p123456', size: null });
    });
  });
});
