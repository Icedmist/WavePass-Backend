import { describe, it, expect, vi } from 'vitest';
import { AdminService } from '../src/modules/admin/admin.service';

describe('AdminService.getFunnel', () => {
  it('aggregates orders, revenue, vouchers, rates, and daily buckets', async () => {
    const prisma: any = {
      order: {
        groupBy: vi.fn(async () => [
          { status: 'AWAITING_PAYMENT', _count: { status: 4 } },
          { status: 'ACTIVE', _count: { status: 6 } },
          { status: 'PAYMENT_FAILED', _count: { status: 2 } },
        ]),
        findMany: vi.fn(async () => [
          { createdAt: new Date() },
          { createdAt: new Date() },
          { createdAt: new Date(Date.now() - 86400000) },
        ]),
      },
      payment: {
        findMany: vi.fn(async () => [
          { amountMinor: 100000, paidAt: new Date() },
          { amountMinor: 50000, paidAt: new Date() },
        ]),
      },
      voucher: {
        groupBy: vi.fn(async () => [
          { status: 'ISSUED', _count: { status: 10 } },
          { status: 'REDEEMED', _count: { status: 6 } },
          { status: 'ACTIVE', _count: { status: 2 } },
        ]),
      },
    };
    const venues: any = { getVenueById: vi.fn(async (id: string) => ({ id })) };
    const svc = new AdminService(prisma, {} as any, venues, {} as any);

    const res = await svc.getFunnel('venue-1', 7);
    expect(res.venueId).toBe('venue-1');
    expect(res.orders).toMatchObject({ initiated: 12, awaitingPayment: 4, active: 6, failed: 2 });
    expect(res.payments).toMatchObject({ fulfilled: 2, revenueMinor: 150000, revenueNGN: 1500 });
    expect(res.vouchers).toMatchObject({ issued: 18, redeemed: 8 });
    expect(res.rates).toMatchObject({ paidPct: 17, redeemPct: 44 });
    expect(res.daily.length).toBe(7);
    expect(res.daily.reduce((a: number, d: any) => a + d.orders, 0)).toBe(3);
    expect(res.daily.reduce((a: number, d: any) => a + d.revenueMinor, 0)).toBe(150000);
  });

  it('handles empty windows without NaN rates', async () => {
    const prisma: any = {
      order: { groupBy: vi.fn(async () => []), findMany: vi.fn(async () => []) },
      payment: { findMany: vi.fn(async () => []) },
      voucher: { groupBy: vi.fn(async () => []) },
    };
    const venues: any = { getVenueById: vi.fn(async (id: string) => ({ id })) };
    const svc = new AdminService(prisma, {} as any, venues, {} as any);
    const res = await svc.getFunnel('venue-1', 7);
    expect(res.rates).toMatchObject({ paidPct: 0, redeemPct: 0 });
    expect(res.daily.length).toBe(7);
  });
});
