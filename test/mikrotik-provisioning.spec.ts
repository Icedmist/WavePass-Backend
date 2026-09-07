import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MikrotikProvisioningProcessor } from '../src/modules/mikrotik/mikrotik-provisioning.processor';

function mockPrisma(overrides: any = {}) {
  return {
    order: { findUniqueOrThrow: vi.fn(), update: vi.fn().mockResolvedValue({}) },
    voucher: { findUniqueOrThrow: vi.fn(), update: vi.fn().mockResolvedValue({}) },
    session: { create: vi.fn().mockResolvedValue({}) },
    $transaction: vi.fn(async (ops: any[]) => {
      for (const op of ops) if (typeof op?.then === 'function') await op;
      return ops;
    }),
    ...overrides,
  } as any;
}

function mockAdapter(overrides: any = {}) {
  return {
    createHotspotUser: vi.fn().mockResolvedValue(undefined),
    getActiveHotspotData: vi.fn().mockResolvedValue([]),
    testConnection: vi.fn().mockResolvedValue(true),
    removeHotspotUser: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as any;
}

describe('MikrotikProvisioningProcessor', () => {
  beforeEach(() => {
    process.env.MIKROTIK_API_USER = 'wavepass';
    process.env.MIKROTIK_API_PASS = 'testpass';
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => [] } as any)));
  });

  it('success: creates hotspot user and session for order with MAC', async () => {
    const prisma = mockPrisma();
    const adapter = mockAdapter();
    const proc = new MikrotikProvisioningProcessor(prisma, adapter);

    prisma.order.findUniqueOrThrow.mockResolvedValue({
      id: 'order-1',
      venueId: 'venue-1',
      customerRef: 'AA:BB:CC:DD:EE:FF',
      plan: { durationSeconds: 3600, dataLimitBytes: null, simultaneousDevices: 1, rateLimit: null },
      venue: { id: 'venue-1', routers: [{ id: 'r1', endpoint: 'http://10.0.0.1', venueId: 'venue-1' }] },
    });

    await (proc as any).provisionForOrder('order-1');

    expect(adapter.createHotspotUser).toHaveBeenCalledTimes(1);
    const call = adapter.createHotspotUser.mock.calls[0];
    expect(call[0]).toBe('http://10.0.0.1');
    expect(call[2].username).toBe('AA:BB:CC:DD:EE:FF');
    expect(prisma.$transaction).toHaveBeenCalled();
  });

  it('retry: throws when no router available', async () => {
    const prisma = mockPrisma();
    const adapter = mockAdapter();
    const proc = new MikrotikProvisioningProcessor(prisma, adapter);

    prisma.order.findUniqueOrThrow.mockResolvedValue({
      id: 'order-2',
      venueId: 'venue-1',
      customerRef: null,
      plan: { durationSeconds: 3600, dataLimitBytes: null, simultaneousDevices: 1, rateLimit: null },
      venue: { id: 'venue-1', routers: [] },
    });

    await expect((proc as any).provisionForOrder('order-2')).rejects.toThrow('No router available');
    expect(adapter.createHotspotUser).not.toHaveBeenCalled();
  });

  it('failure: propagates Mikrotik adapter error for retry', async () => {
    const prisma = mockPrisma();
    const adapter = mockAdapter({ createHotspotUser: vi.fn().mockRejectedValue(new Error('RouterOS 500')) });
    const proc = new MikrotikProvisioningProcessor(prisma, adapter);

    prisma.order.findUniqueOrThrow.mockResolvedValue({
      id: 'order-3',
      venueId: 'venue-1',
      customerRef: null,
      plan: { durationSeconds: 3600, dataLimitBytes: null, simultaneousDevices: 1, rateLimit: null },
      venue: { id: 'venue-1', routers: [{ id: 'r1', endpoint: 'http://10.0.0.1', venueId: 'venue-1' }] },
    });

    await expect((proc as any).provisionForOrder('order-3')).rejects.toThrow('RouterOS 500');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('voucher success path', async () => {
    const prisma = mockPrisma();
    const adapter = mockAdapter();
    const proc = new MikrotikProvisioningProcessor(prisma, adapter);

    prisma.voucher.findUniqueOrThrow.mockResolvedValue({
      id: 'v1',
      venueId: 'venue-1',
      plan: { durationSeconds: 86400, dataLimitBytes: BigInt(10 * 1024 * 1024 * 1024), simultaneousDevices: 1 },
      venue: { id: 'venue-1', routers: [{ id: 'r1', endpoint: 'http://10.0.0.1', venueId: 'venue-1' }] },
    });

    await (proc as any).provisionForVoucher('v1');
    expect(adapter.createHotspotUser).toHaveBeenCalledTimes(1);
    expect(prisma.$transaction).toHaveBeenCalled();
  });
});
