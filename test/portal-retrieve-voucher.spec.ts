import { describe, it, expect, vi } from 'vitest';
import { PortalService } from '../src/modules/portal/portal.service';

function makeService(prisma: any) {
  const paystack: any = { isMock: () => true };
  const plans: any = {
    getPlanById: vi.fn(async (id: string) => ({ id, name: '1 Hour Quick Pass', priceMinor: 50000, durationSeconds: 3600 })),
    listPlans: vi.fn(async () => [{ id: 'plan-1' }]),
  };
  const venues: any = {
    getVenueById: vi.fn(async (id: string) => ({ id, slug: 'flagship' })),
    getVenueBySlug: vi.fn(async (slug: string) => ({ id: 'venue-uuid-1', slug })),
    getDefaultVenue: vi.fn(async () => ({ id: 'venue-uuid-1', slug: 'flagship' })),
  };
  const queue: any = { enqueue: vi.fn(async () => ({})) };
  return new PortalService(prisma, paystack, plans, venues, queue);
}

describe('PortalService.retrieveVoucher iPhone & Universal Retrieval Tests', () => {
  it('retrieves active voucher by MAC address (with alternate delimiter)', async () => {
    const expiresAt = new Date(Date.now() + 1800 * 1000);
    const prisma: any = {
      voucher: {
        findMany: vi.fn(async () => [
          {
            id: 'v-1',
            displayCodeEnc: '987654',
            redeemedMac: '00:11:22:33:44:55',
            status: 'ACTIVE',
            expiresAt,
            plan: { name: '1 Hour Quick Pass', durationSeconds: 3600 },
          },
        ]),
        findFirst: vi.fn(async () => null),
        update: vi.fn(async () => ({})),
      },
      order: { findFirst: vi.fn(async () => null), findMany: vi.fn(async () => []) },
      payment: { findFirst: vi.fn(async () => null) },
    };

    const service = makeService(prisma);
    // Passing MAC with dashes (common in RouterOS / iOS)
    const res = await service.retrieveVoucher({ mac: '00-11-22-33-44-55', venueId: 'flagship' });
    expect(res.found).toBe(true);
    expect(res.voucherCode).toBe('987654');
    expect(res.status).toBe('ACTIVE');
  });

  it('retrieves voucher by phone number when iPhone MAC rotated and re-binds to new MAC', async () => {
    const expiresAt = new Date(Date.now() + 1800 * 1000);
    let updatedVoucherData: any = null;
    const prisma: any = {
      voucher: {
        findMany: vi.fn(async () => []), // No match on new iPhone MAC initially
        findFirst: vi.fn(async () => null),
        update: vi.fn(async ({ data }: any) => {
          updatedVoucherData = data;
          return {};
        }),
      },
      payment: { findFirst: vi.fn(async () => null) },
      order: {
        findFirst: vi.fn(async () => null),
        findMany: vi.fn(async () => [
          {
            id: 'order-1',
            customerRef: '08012345678',
            status: 'PAID',
            plan: { name: '1 Hour Quick Pass', durationSeconds: 3600 },
            payment: {
              vouchers: [
                {
                  id: 'v-saved',
                  displayCodeEnc: '556677',
                  redeemedMac: 'AA:BB:CC:DD:EE:01', // Old MAC from before rotation
                  status: 'ACTIVE',
                  expiresAt,
                  plan: { name: '1 Hour Quick Pass', durationSeconds: 3600 },
                },
              ],
            },
          },
        ]),
      },
    };

    const service = makeService(prisma);
    // iPhone queries with new Private MAC and their phone number in query
    const res = await service.retrieveVoucher({
      mac: '12:34:56:78:9A:BC',
      q: '08012345678',
      venueId: 'flagship',
    });

    expect(res.found).toBe(true);
    expect(res.voucherCode).toBe('556677');
    // Verifies the voucher was automatically re-bound to the iPhone's new MAC
    expect(updatedVoucherData?.redeemedMac).toBe('12:34:56:78:9A:BC');
  });

  it('retrieves voucher by transfer reference (e.g. TRF-...)', async () => {
    const expiresAt = new Date(Date.now() + 2400 * 1000);
    const prisma: any = {
      voucher: {
        findMany: vi.fn(async () => []),
        findFirst: vi.fn(async () => null),
        update: vi.fn(async () => ({})),
      },
      payment: {
        findFirst: vi.fn(async () => ({
          id: 'pay-1',
          providerReference: 'TRF-MK81-ABCD',
          vouchers: [
            {
              id: 'v-trf',
              displayCodeEnc: '334455',
              redeemedMac: 'AA:BB:CC:DD:EE:FF',
              status: 'ACTIVE',
              expiresAt,
              plan: { name: 'Day Pass', durationSeconds: 86400 },
            },
          ],
          order: { plan: { name: 'Day Pass' } },
        })),
      },
      order: { findFirst: vi.fn(async () => null), findMany: vi.fn(async () => []) },
    };

    const service = makeService(prisma);
    const res = await service.retrieveVoucher({
      q: 'TRF-MK81-ABCD',
      venueId: 'flagship',
    });

    expect(res.found).toBe(true);
    expect(res.voucherCode).toBe('334455');
  });

  it('returns pendingApproval when transfer request is still awaiting venue owner approval', async () => {
    const prisma: any = {
      voucher: {
        findMany: vi.fn(async () => []),
        findFirst: vi.fn(async () => null),
      },
      payment: { findFirst: vi.fn(async () => null) },
      order: {
        findFirst: vi.fn(async () => ({
          id: 'order-pending',
          customerRef: '00:11:22:33:44:55',
          status: 'AWAITING_PAYMENT',
          amountMinor: 100000,
          plan: { name: 'Day Pass' },
        })),
        findMany: vi.fn(async () => []),
      },
    };

    const service = makeService(prisma);
    const res = await service.retrieveVoucher({
      mac: '00:11:22:33:44:55',
      venueId: 'flagship',
    });

    expect(res.found).toBe(false);
    expect(res.pendingApproval).toBe(true);
    expect(res.planName).toBe('Day Pass');
  });
});
