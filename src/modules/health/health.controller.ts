import { Controller, Get } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';

@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  health() {
    return {
      status: 'ok',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    };
  }

  @Get('ready')
  async ready() {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { status: 'ready', db: 'ok', timestamp: new Date().toISOString() };
    } catch {
      return { status: 'degraded', db: 'unreachable', timestamp: new Date().toISOString() };
    }
  }
}
