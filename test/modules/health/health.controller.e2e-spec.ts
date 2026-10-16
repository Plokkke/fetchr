import { HttpStatus } from '@nestjs/common';
import * as request from 'supertest';

import { APP, CONFIG } from '?/setup/e2e-setup';

import { HealthService } from '@/modules/health/health.service';

describe('Health controller', () => {
  describe('Status', () => {
    it('should return the running version', async () => {
      const response = await request(APP.getHttpServer()).get('/health').send();
      expect(response.status).toBe(HttpStatus.OK);
      expect(response.body).toStrictEqual({ status: 'ok', version: CONFIG.server.version });
    });
  });

  describe('Startup', () => {
    async function endpointCall() {
      return request(APP.getHttpServer()).get(`/health/startup`).send();
    }

    it('should return 200', async () => {
      const response = await endpointCall();
      expect(response.status).toBe(HttpStatus.NO_CONTENT);
    });
  });

  describe('Liveness', () => {
    async function endpointCall() {
      return request(APP.getHttpServer()).get(`/health/liveness`).send();
    }

    it('should return 200', async () => {
      const response = await endpointCall();
      expect(response.status).toBe(HttpStatus.OK);
    });

    it('should failed when service is down', async () => {
      const healthService: HealthService = APP.get<HealthService>(HealthService);

      healthService.addLivenessCheck('service', () => false);

      const response = await endpointCall();
      expect(response.status).toBe(HttpStatus.SERVICE_UNAVAILABLE);
      expect(response.body).toStrictEqual({
        status: 'error',
        info: {},
        error: { service: { status: 'down' } },
        details: { service: { status: 'down' } },
      });

      healthService.removeLivenessCheck('service');
    });
  });

  describe('Readiness', () => {
    async function endpointCall() {
      return request(APP.getHttpServer()).get(`/health/readiness`).send();
    }

    it('should return 200', async () => {
      const response = await endpointCall();
      expect(response.status).toBe(HttpStatus.OK);
    });

    it('should failed when service is down', async () => {
      const healthService: HealthService = APP.get<HealthService>(HealthService);

      healthService.addReadinessCheck('service', () => false);

      const response = await endpointCall();
      expect(response.status).toBe(HttpStatus.SERVICE_UNAVAILABLE);
      expect(response.body).toMatchObject({
        status: 'error',
        error: { service: { status: 'down' } },
      });

      healthService.removeReadinessCheck('service');
    });
  });
});
