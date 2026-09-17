import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MikrotikProvisioningProcessor } from '../src/modules/mikrotik/mikrotik-provisioning.processor';

function mockPrisma(overrides: any = {}) {
  return {
    order: { findUniqueOrThrow: vi.fn(), update: vi.fn().mockResolvedValue({}) },
    voucher: {
      findUniqueOrThrow: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    session: { create: vi.fn().mockResolvedValue({}), findFirst: vi.fn(async () => null) },
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

  it('offline: creates cloud voucher and marks ACTIVE without router (no throw)', async () => {
    const prisma = mockPrisma({
      payment: { findUnique: vi.fn().mockResolvedValue(null) },
      voucher: { create: vi.fn().mockResolvedValue({ id: 'v-off', displayCodeEnc: '123456' }) },
    });
    const adapter = mockAdapter();
    const proc = new MikrotikProvisioningProcessor(prisma, adapter);

    prisma.order.findUniqueOrThrow.mockResolvedValue({
      id: 'order-2',
      venueId: 'venue-1',
      customerRef: null,
      plan: { durationSeconds: 3600, dataLimitBytes: null, simultaneousDevices: 1, rateLimit: null },
      venue: { id: 'venue-1', routers: [] },
    });

    await (proc as any).provisionForOrder('order-2');
    expect(adapter.createHotspotUser).not.toHaveBeenCalled();
    expect(prisma.voucher.create).toHaveBeenCalled();
    expect(prisma.order.update).toHaveBeenCalledWith({
      where: { id: 'order-2' },
      data: { status: 'ACTIVE' },
    });
  });

  it('degrade: any router error still yields ACTIVE order + session (paid access never lost)', async () => {
    for (const msg of ['RouterOS 500', 'EHOSTUNREACH', 'ECONNRESET', 'socket hang up']) {
      const prisma = mockPrisma();
      const adapter = mockAdapter({ createHotspotUser: vi.fn().mockRejectedValue(new Error(msg)) });
      const proc = new MikrotikProvisioningProcessor(prisma, adapter);

      prisma.order.findUniqueOrThrow.mockResolvedValue({
        id: 'order-3',
        venueId: 'venue-1',
        customerRef: null,
        plan: { durationSeconds: 3600, dataLimitBytes: null, simultaneousDevices: 1, rateLimit: null },
        venue: { id: 'venue-1', routers: [{ id: 'r1', endpoint: 'http://10.0.0.1', venueId: 'venue-1' }] },
      });
      prisma.payment = { findUnique: vi.fn().mockResolvedValue(null) } as any;
      prisma.voucher = { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({ id: 'v-3', displayCodeEnc: '111111' }) } as any;

      await (proc as any).provisionForOrder('order-3');
      expect(prisma.$transaction).toHaveBeenCalled();
      expect(prisma.order.update).toHaveBeenCalledWith({
        where: { id: 'order-3' },
        data: { status: 'ACTIVE' },
      });
    }
  });

  it('voucher success path', async () => {
    const prisma = mockPrisma();
    const adapter = mockAdapter();
    const proc = new MikrotikProvisioningProcessor(prisma, adapter);

    prisma.voucher.findUniqueOrThrow.mockResolvedValue({
      id: 'v1',
      displayCodeEnc: 'WP-TEST-1234',
      venueId: 'venue-1',
      plan: { durationSeconds: 86400, dataLimitBytes: BigInt(10 * 1024 * 1024 * 1024), simultaneousDevices: 1 },
      venue: { id: 'venue-1', routers: [{ id: 'r1', endpoint: 'http://10.0.0.1', venueId: 'venue-1' }] },
    });

    await (proc as any).provisionForVoucher('v1');
    expect(adapter.createHotspotUser).toHaveBeenCalledTimes(1);
    const call = adapter.createHotspotUser.mock.calls[0];
    expect(call[0]).toBe('http://10.0.0.1');
    expect(call[2].username).toBe('WP-TEST-1234');
    expect(call[2].password).toBe('WP-TEST-1234');
    expect(prisma.$transaction).toHaveBeenCalled();
  });

  it('binds MAC address for single-device voucher when redeemedMac is present', async () => {
    const prisma = mockPrisma();
    const adapter = mockAdapter();
    const proc = new MikrotikProvisioningProcessor(prisma, adapter);

    prisma.voucher.findUniqueOrThrow.mockResolvedValue({
      id: 'v-mac-1',
      displayCodeEnc: 'WP-MAC-1234',
      redeemedMac: '11:22:33:44:55:66',
      venueId: 'venue-1',
      plan: { durationSeconds: 3600, dataLimitBytes: null, simultaneousDevices: 1, rateLimit: null },
      venue: { id: 'venue-1', routers: [{ id: 'r1', endpoint: 'http://10.0.0.1', venueId: 'venue-1' }] },
    });

    await (proc as any).provisionForVoucher('v-mac-1');
    expect(adapter.createHotspotUser).toHaveBeenCalledTimes(1);
    const call = adapter.createHotspotUser.mock.calls[0];
    expect(call[2].macAddress).toBe('11:22:33:44:55:66');
    expect(call[2].sharedUsers).toBe(1);
  });

  it('does not bind MAC address and selects profile_duo for multi-device plan (simultaneousDevices = 2)', async () => {
    const prisma = mockPrisma();
    const adapter = mockAdapter();
    const proc = new MikrotikProvisioningProcessor(prisma, adapter);

    prisma.order.findUniqueOrThrow.mockResolvedValue({
      id: 'order-duo',
      venueId: 'venue-1',
      customerRef: 'AA:BB:CC:DD:EE:FF',
      plan: { durationSeconds: 86400, dataLimitBytes: null, simultaneousDevices: 2, rateLimit: null },
      venue: { id: 'venue-1', routers: [{ id: 'r1', endpoint: 'http://10.0.0.1', venueId: 'venue-1' }] },
    });

    await (proc as any).provisionForOrder('order-duo');
    expect(adapter.createHotspotUser).toHaveBeenCalledTimes(1);
    const call = adapter.createHotspotUser.mock.calls[0];
    expect(call[2].macAddress).toBeUndefined();
    expect(call[2].profile).toBe('profile_duo');
    expect(call[2].sharedUsers).toBe(2);
  });

  it('does not bind MAC address and selects profile_family for multi-device plan (simultaneousDevices = 5)', async () => {
    const prisma = mockPrisma();
    const adapter = mockAdapter();
    const proc = new MikrotikProvisioningProcessor(prisma, adapter);

    prisma.voucher.findUniqueOrThrow.mockResolvedValue({
      id: 'v-family',
      displayCodeEnc: 'WP-FAM-5555',
      redeemedMac: '11:22:33:44:55:66',
      venueId: 'venue-1',
      plan: { durationSeconds: 86400, dataLimitBytes: null, simultaneousDevices: 5, rateLimit: null },
      venue: { id: 'venue-1', routers: [{ id: 'r1', endpoint: 'http://10.0.0.1', venueId: 'venue-1' }] },
    });

    await (proc as any).provisionForVoucher('v-family');
    expect(adapter.createHotspotUser).toHaveBeenCalledTimes(1);
    const call = adapter.createHotspotUser.mock.calls[0];
    expect(call[2].macAddress).toBeUndefined();
    expect(call[2].profile).toBe('profile_family');
    expect(call[2].sharedUsers).toBe(5);
  });
});
