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

  it('scopes customer email to venue id and slug so venues with identical names have distinct emails', async () => {
    const prisma = mockPrisma(null);
    const paystack: any = {
      isMock: () => false,
      createCustomer: vi.fn(async (email: string) => {
        expect(email).toBe('venue.cafe.venue-1@nexawavepass.com');
        return { customer_code: 'cus_unique_venue_1' };
      }),
      createDedicatedAccount: vi.fn(async () => ({
        id: 101,
        account_number: '9817850001',
        account_name: 'NEXAWAVEPASS/CAFE',
        bank: { name: 'Wema Bank', slug: 'wema-bank' },
      })),
    };
    const svc = new VirtualAccountsService(prisma, paystack, venues);
    const res = await svc.ensureForVenue('venue-1');

    expect(paystack.createCustomer).toHaveBeenCalledWith(
      'venue.cafe.venue1@nexawavepass.com',
      expect.anything(),
    );
    expect(res.accountNumber).toBe('9817850001');
  });

  it('detects and replaces a collided active DVA that was shared with another venue', async () => {
    const collidedRow = {
      id: 'va-collided',
      venueId: 'venue-2',
      status: 'ACTIVE',
      accountNumber: '9817850525', // Already claimed by venue-1
      bankName: 'Wema Bank',
      metadata: { providerId: 40430777 },
    };
    const prisma: any = {
      virtualAccount: {
        findUnique: vi.fn(async () => collidedRow),
        // Returns the other venue that already owns this account number
        findFirst: vi.fn(async () => ({ id: 'va-original', venueId: 'venue-1', accountNumber: '9817850525' })),
        create: vi.fn(async ({ data }: any) => ({ id: 'va-new-unique', ...data })),
        update: vi.fn(async ({ data }: any) => ({ ...collidedRow, ...data })),
        delete: vi.fn(async () => collidedRow),
      },
    };
    const paystack: any = {
      isMock: () => false,
      createCustomer: vi.fn(async () => ({ customer_code: 'cus_unique_venue_2' })),
      createDedicatedAccount: vi.fn(async () => ({
        id: 102,
        account_number: '9817852419', // Fresh dedicated account
        account_name: 'NEXAWAVEPASS/VENUE TWO',
        bank: { name: 'Wema Bank', slug: 'wema-bank' },
      })),
    };
    const venuesMock: any = {
      getVenueById: vi.fn(async () => ({ id: 'venue-2', name: 'Test', slug: 'test-2' })),
    };
    const svc = new VirtualAccountsService(prisma, paystack, venuesMock);
    const res = await svc.ensureForVenue('venue-2');

    expect(prisma.virtualAccount.delete).toHaveBeenCalledWith({ where: { venueId: 'venue-2' } });
    expect(paystack.createDedicatedAccount).toHaveBeenCalled();
    expect(res.accountNumber).toBe('9817852419');
  });
});
