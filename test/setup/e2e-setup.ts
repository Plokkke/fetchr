import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { INestApplication } from '@nestjs/common';
import { WsAdapter } from '@nestjs/platform-ws';
import { Test, TestingModule } from '@nestjs/testing';
import * as nock from 'nock';

import { configureAppModule } from '@/app.module';
import { EnvironmentVariables } from '@/environment';

export let APP: INestApplication;
export const CONFIG: EnvironmentVariables = {
  server: {
    port: 3000,
    apiKey: '13e4872b-12af-4707-85d6-8b7dbcdc6878',
    logLevel: 'info',
    version: '1.2.3',
  },
  downloadsPath: mkdtempSync(join(tmpdir(), 'fetchr-e2e-')),
  maxConcurrentDownloads: 3,
  hostPlugins: ['fetchr-push'],
  archivePlugins: [],
};

beforeAll(async () => {
  try {
    const AppModule = configureAppModule(CONFIG);
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    APP = moduleFixture.createNestApplication();
    APP.useWebSocketAdapter(new WsAdapter(APP));

    await APP.init();
  } catch (e) {
    console.error(e);
    throw e;
  }
});

beforeEach(() => {
  nock.cleanAll();
});

afterAll(async () => {
  await APP.close();
});
