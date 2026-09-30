import { describe, it, expect, vi } from 'vitest';
import { VirtualAccountsService } from '../src/modules/virtual-accounts/virtual-accounts.service';

function mockPrisma(existing: any) {
  return {
    virtualAccount: {
      findUnique: vi.fn(async () => existing),
      findFirst: vi.fn(async () => null),
      create: vi.fn(async ({ data }: any) => ({ id: 'va-new', ...data })),
      update: vi.fn(async ({ data }: any) => ({ ...(existing || {}), ...data })),
      delete: vi.fn(async () => existing),
    },
  } as any;
}

const venues: any = {
  getVenueById: vi.fn(async (id: string) => ({ id, name: 'Cafe', slug: 'cafe' })),
};

describe('VirtualAccountsService mock-row replacement', () => {
  it('replaces a stale mock DVA with a live one when keys are configured', async () => {
    const mockRow = {
      id: 'va-mock', venueId: 'venue-1', status: 'ACTIVE',
      accountNumber: '9123456789', bankName: 'Wema Bank (mock)',
      metadata: { mock: true },
    };
    const prisma = mockPrisma(mockRow);
    const paystack: any = {
      isMock: () => false,
      createCustomer: vi.fn(async () => ({ customer_code: 'cus_live' })),
      createDedicatedAccount: vi.fn(async () => ({
        id: 7, account_number: '0112345678', account_name: 'Cafe', bank: { name: 'Wema Bank' },
      })),
    };
    const svc = new VirtualAccountsService(prisma, paystack, venues);
    const res = await svc.ensureForVenue('venue-1');
    expect(prisma.virtualAccount.delete).toHaveBeenCalledWith({ where: { venueId: 'venue-1' } });
    expect(paystack.createDedicatedAccount).toHaveBeenCalled();
    expect(res.accountNumber).toBe('0112345678');
    expect(res.status).toBe('ACTIVE');
  });

  it('keeps returning the mock row while still in mock mode', async () => {
    const mockRow = {
      id: 'va-mock', venueId: 'venue-1', status: 'ACTIVE',
      accountNumber: '9123456789', bankName: 'Wema Bank (mock)',
      metadata: { mock: true },
    };
    const prisma = mockPrisma(mockRow);
    const paystack: any = { isMock: () => true };
    const svc = new VirtualAccountsService(prisma, paystack, venues);
    const res = await svc.ensureForVenue('venue-1');
    expect(res).toBe(mockRow);
    expect(prisma.virtualAccount.delete).not.toHaveBeenCalled();
  });

  it('keeps a real ACTIVE DVA untouched in live mode', async () => {
    const liveRow = {
      id: 'va-live', venueId: 'venue-1', status: 'ACTIVE',
      accountNumber: '0112345678', bankName: 'Wema Bank', metadata: { providerId: 7 },
    };
    const prisma = mockPrisma(liveRow);
    const paystack: any = { isMock: () => false, createDedicatedAccount: vi.fn() };
    const svc = new VirtualAccountsService(prisma, paystack, venues);
    const res = await svc.ensureForVenue('venue-1');
    expect(res).toBe(liveRow);
    expect(paystack.createDedicatedAccount).not.toHaveBeenCalled();
  });

  it('passes first_name, last_name, and phone to Paystack createCustomer and upgrades PENDING rows', async () => {
    const pendingRow = {
      id: 'va-pending', venueId: 'venue-1', status: 'PENDING',
      accountNumber: 'PENDING', bankName: 'Paystack Dedicated NUBAN (Pending)',
      metadata: { note: 'pending' },
    };
    const prisma = mockPrisma(pendingRow);
    const paystack: any = {
      isMock: () => false,
      createCustomer: vi.fn(async (_email: string, extra: any) => {
        expect(extra.first_name).toBeDefined();
        expect(extra.last_name).toBeDefined();
        expect(extra.phone).toBeDefined();
        return { customer_code: 'cus_live_with_phone' };
      }),
      createDedicatedAccount: vi.fn(async () => ({
        id: 99,
        account_number: '9817850525',
        account_name: 'NEXAWAVEPASS/VENUE TEST',
        bank: { name: 'Wema Bank', slug: 'wema-bank' },
      })),
    };
    const svc = new VirtualAccountsService(prisma, paystack, venues);
    const res = await svc.ensureForVenue('venue-1', { phone: '08012345678' });

    expect(prisma.virtualAccount.delete).toHaveBeenCalledWith({ where: { venueId: 'venue-1' } });
    expect(paystack.createCustomer).toHaveBeenCalledWith(
      expect.stringContaining('@nexawavepass.com'),
      expect.objectContaining({
        first_name: 'Cafe',
        last_name: 'Venue',
        phone: '+2348012345678',
      }),
    );
    expect(paystack.createDedicatedAccount).toHaveBeenCalled();
    expect(res.accountNumber).toBe('9817850525');
    expect(res.status).toBe('ACTIVE');
  });

  it('stores PENDING when Paystack DVA creation fails or returns no account number', async () => {
    const prisma = mockPrisma(null);
    const paystack: any = {
      isMock: () => false,
      createCustomer: vi.fn(async () => ({ customer_code: 'cus_new' })),
      createDedicatedAccount: vi.fn(async () => {
        throw new Error('Customer identification required');
      }),
    };
    const svc = new VirtualAccountsService(prisma, paystack, venues);
    const res = await svc.ensureForVenue('venue-1');

    expect(res.accountNumber).toBe('PENDING');
    expect(res.status).toBe('PENDING');
  });
});
