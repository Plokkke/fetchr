import { Controller, Get, HttpCode, HttpStatus, VERSION_NEUTRAL } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HealthCheck, HealthCheckResult, HealthCheckService } from '@nestjs/terminus';

import type { Config } from '@/app.module';
import { HealthService } from '@/modules/health/health.service';

@Controller({ path: '/health', version: VERSION_NEUTRAL })
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly service: HealthService,
    private readonly config: ConfigService<Config, true>,
  ) {}

  @Get()
  check(): { status: 'ok'; version: string } {
    return { status: 'ok', version: this.config.get('server.version', { infer: true }) };
  }

  @Get('/startup')
  @HttpCode(HttpStatus.NO_CONTENT)
  @HealthCheck()
  async checkStartup(): Promise<void> {
    return;
  }

  @Get('/liveness')
  @HealthCheck()
  async checkLiveness(): Promise<HealthCheckResult> {
    return this.health.check(this.service.livenessChecks);
  }

  @Get('/readiness')
  @HealthCheck()
  async checkReadiness(): Promise<HealthCheckResult> {
    return this.health.check(this.service.readinessChecks);
  }
}
