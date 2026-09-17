import { describe, it, expect, vi } from 'vitest';
import { AdminService } from '../src/modules/admin/admin.service';

function mockPrisma(overrides: any = {}) {
  return {
    payment: {
      findFirst: vi.fn(async () => null),
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => 0),
      update: vi.fn(async ({ data }: any) => ({ ...data })),
    },
    voucher: {
      update: vi.fn(async ({ data }: any) => ({ ...data })),
    },
    order: {
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => 0),
      update: vi.fn(async () => ({})),
    },
    webhookEvent: {
      count: vi.fn(async () => 0),
    },
    session: {
      count: vi.fn(async () => 0),
      findMany: vi.fn(async () => []),
    },
    venue: {
      count: vi.fn(async () => 0),
    },
    virtualAccount: {
      groupBy: vi.fn(async () => []),
    },
    plan: {
      count: vi.fn(async () => 0),
    },
    router: {
      groupBy: vi.fn(async () => []),
    },
    ...overrides,
  } as any;
}

function makeService(prisma: any) {
  const notifications: any = { create: vi.fn(async () => ({ id: 'n-1' })) };
  const svc = new AdminService(prisma, {} as any, {} as any, {} as any, {} as any, notifications);
  return { svc, notifications };
}

describe('AdminService.handlePaymentReversal', () => {
  it('revokes unused vouchers and marks REFUNDED on refund.processed', async () => {
    const prisma = mockPrisma({
      payment: {
        findFirst: vi.fn(async () => ({
          id: 'pay-1', providerReference: 'wp_x', amountMinor: 50000, status: 'FULFILLED',
          order: { venueId: 'venue-1', plan: { name: '1 Hour' } },
          vouchers: [
            { id: 'v-unused', status: 'ACTIVE', firstLoginAt: null },
            { id: 'v-used', status: 'REDEEMED', firstLoginAt: new Date() },
          ],
        })),
        findMany: vi.fn(async () => []),
        count: vi.fn(async () => 0),
        update: vi.fn(async () => ({})),
      },
    });
    const { svc, notifications } = makeService(prisma);
    const res: any = await svc.handlePaymentReversal('refund.processed', {
      transaction_reference: 'wp_x', amount: 50000, status: 'processed',
    });
    expect(res.ok).toBe(true);
    expect(res.revokedVouchers).toEqual(['v-unused']);
    expect(res.needsReview).toBe(true);
    expect(notifications.create).toHaveBeenCalled();
  });

  it('notes refund.failed without mutating', async () => {
    const prisma = mockPrisma({
      payment: {
        findFirst: vi.fn(async () => ({ id: 'pay-1', status: 'FULFILLED', order: {}, vouchers: [] })),
        findMany: vi.fn(async () => []),
        count: vi.fn(async () => 0),
        update: vi.fn(async () => ({})),
      },
    });
    const { svc } = makeService(prisma);
    const res: any = await svc.handlePaymentReversal('refund.failed', { transaction_reference: 'wp_x' });
    expect(res.ok).toBe(true);
    expect(res.action).toBe('noted');
    expect(prisma.voucher.update).not.toHaveBeenCalled();
  });

  it('returns unknown for unmatched references', async () => {
    const prisma = mockPrisma();
    const { svc } = makeService(prisma);
    const res: any = await svc.handlePaymentReversal('charge.dispute.create', { reference: 'nope' });
    expect(res.ok).toBe(false);
  });
});

describe('AdminService.getReviewQueue', () => {
  it('aggregates actionable cases with counts', async () => {
    const prisma = mockPrisma({
      order: {
        findMany: vi.fn(async ({ where }: any) =>
          where.status === 'REFUND_REQUIRED' ? [{ id: 'o-1' }] : [{ id: 'o-2' }],
        ),
        count: vi.fn(async () => 0),
        update: vi.fn(async () => ({})),
      },
      payment: {
        findFirst: vi.fn(async () => null),
        findMany: vi.fn(async ({ where }: any) =>
          where.status?.in?.includes('FAILED') ? [{ id: 'p-1' }] : [{ id: 'p-2' }],
        ),
        count: vi.fn(async () => 0),
        update: vi.fn(async () => ({})),
      },
    });
    const { svc } = makeService(prisma);
    const res: any = await svc.getReviewQueue();
    expect(res.counts.total).toBe(4);
    expect(res.refundRequired.length).toBe(1);
    expect(res.stuckProvisioning.length).toBe(1);
  });
});

describe('AdminService.getMetrics', () => {
  it('computes PRD rates without NaN on empty windows', async () => {
    const prisma = mockPrisma();
    const { svc } = makeService(prisma);
    const res: any = await svc.getMetrics(7);
    expect(res.days).toBe(7);
    expect(res.payments.successPct).toBe(0);
    expect(res.rates).toBeUndefined();
    expect(res.accessLatencyMedianSec).toBeNull();
    expect(res.onboarding.venues).toBe(0);
  });

  it('computes conversion and latency from sampled data', async () => {
    const now = Date.now();
    const prisma = mockPrisma({
      order: {
        findMany: vi.fn(async () => [
          { id: 'o-1', payment: { paidAt: new Date(now - 60000) } },
          { id: 'o-2', payment: { paidAt: new Date(now - 120000) } },
        ]),
        count: vi.fn(async () => 10),
        update: vi.fn(async () => ({})),
      },
      payment: {
        findFirst: vi.fn(async () => null),
        findMany: vi.fn(async () => []),
        count: vi.fn(async () => 8),
        update: vi.fn(async () => ({})),
      },
      session: {
        count: vi.fn(async () => 7),
        findMany: vi.fn(async () => [
          { orderId: 'o-1', startedAt: new Date(now - 30000) },
          { orderId: 'o-2', startedAt: new Date(now - 60000) },
        ]),
      },
    });
    const { svc } = makeService(prisma);
    const res: any = await svc.getMetrics(7);
    expect(res.payments).toMatchObject({ initiated: 10, fulfilled: 8, successPct: 80 });
    expect(res.accessLatencyMedianSec).toBe(60);
  });
});
