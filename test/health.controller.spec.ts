import { describe, it, expect, vi } from 'vitest';
import { HealthController } from '../src/modules/health/health.controller';

describe('HealthController unit tests', () => {
  it('health() returns ok status with uptime and timestamp', () => {
    const controller = new HealthController({} as any);
    const res = controller.health();

    expect(res.status).toBe('ok');
    expect(typeof res.uptime).toBe('number');
    expect(res.timestamp).toBeDefined();
  });

  it('ready() returns ready and db ok when query succeeds', async () => {
    const prisma: any = {
      $queryRaw: vi.fn(async () => [{ 1: 1 }]),
    };
    const controller = new HealthController(prisma);
    const res = await controller.ready();

    expect(res.status).toBe('ready');
    expect(res.db).toBe('ok');
    expect(res.timestamp).toBeDefined();
  });

  it('ready() returns degraded and db unreachable when query throws', async () => {
    const prisma: any = {
      $queryRaw: vi.fn(async () => {
        throw new Error('Connection refused');
      }),
    };
    const controller = new HealthController(prisma);
    const res = await controller.ready();

    expect(res.status).toBe('degraded');
    expect(res.db).toBe('unreachable');
    expect(res.timestamp).toBeDefined();
  });
});
