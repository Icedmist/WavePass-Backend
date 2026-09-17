import { describe, it, expect, vi } from 'vitest';
import { PortalService } from '../src/modules/portal/portal.service';

function makeService(prisma: any) {
  const paystack: any = { isMock: () => true };
  const plans: any = {
    getPlanById: vi.fn(async (id: string) => ({ id, name: '1 Hour', priceMinor: 50000, durationSeconds: 3600 })),
    listPlans: vi.fn(async () => [{ id: 'plan-1' }]),
  };
  const venues: any = {
    getVenueById: vi.fn(async (id: string) => ({ id })),
    getDefaultVenue: vi.fn(async () => ({ id: 'venue-1' })),
  };
  const queue: any = { enqueue: vi.fn(async () => ({})) };
  return new PortalService(prisma, paystack, plans, venues, queue);
}

function mockPrisma(orderRef: string) {
  const createdVouchers: any[] = [];
  const updatedOrders: any[] = [];
  const prisma: any = {
    order: {
      findUnique: vi.fn(async () => ({
        id: 'order-1', venueId: 'venue-1', planId: 'plan-1',
        customerRef: orderRef, amountMinor: 50000,
        plan: { durationSeconds: 3600, name: '1 Hour' }, venue: { id: 'venue-1' },
      })),
      findFirst: vi.fn(async () => null),
      update: vi.fn(async ({ where, data }: any) => { updatedOrders.push({ where, data }); return {}; }),
    },
    payment: { create: vi.fn(async ({ data }: any) => ({ id: 'pay-1', ...data })) },
    voucher: {
      create: vi.fn(async ({ data }: any) => { createdVouchers.push(data); return { id: 'v-1', ...data }; }),
    },
  };
  return { prisma, createdVouchers, updatedOrders };
}

describe('PortalService.approveAccess MAC binding', () => {
  it('uses the approval MAC when valid', async () => {
    const { prisma, createdVouchers } = mockPrisma('AA:BB:CC:DD:EE:01');
    const res = await makeService(prisma).approveAccess({
      venueId: 'venue-1', orderId: 'order-1', mac: 'aa:bb:cc:dd:ee:02',
    });
    expect(res.ok).toBe(true);
    expect(res.voucherCode).toMatch(/^\d{6}$/);
    expect(createdVouchers[0].redeemedMac).toBe('AA:BB:CC:DD:EE:02');
  });

  it('falls back to the order MAC and repairs dummy refs', async () => {
    const { prisma, createdVouchers, updatedOrders } = mockPrisma('02:00:00:00:00:01');
    // order ref is a dummy, approval carries the real device MAC
    const res = await makeService(prisma).approveAccess({
      venueId: 'venue-1', orderId: 'order-1', mac: 'AA:BB:CC:DD:EE:FF',
    });
    expect(res.ok).toBe(true);
    expect(createdVouchers[0].redeemedMac).toBe('AA:BB:CC:DD:EE:FF');
    expect(updatedOrders.some((u) => u.data.customerRef === 'AA:BB:CC:DD:EE:FF')).toBe(true);
  });

  it('throws when neither approval nor order has a valid MAC', async () => {
    const { prisma } = mockPrisma('02:00:00:00:00:01');
    await expect(
      makeService(prisma).approveAccess({ venueId: 'venue-1', orderId: 'order-1', mac: '' }),
    ).rejects.toThrow('Valid guest device MAC required');
  });

  it('submitTransferRequest rejects MAC-less requests instead of inventing a dummy', async () => {
    const { prisma } = mockPrisma('AA:BB:CC:DD:EE:01');
    const svc = makeService(prisma);
    await expect(
      svc.submitTransferRequest({ venueSlug: 'venue-1', mac: '', planId: 'plan-1' } as any),
    ).rejects.toThrow('Valid device MAC required');
  });
});
