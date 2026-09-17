import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CashoutsService } from '../src/modules/cashouts/cashouts.service';

function mockPrisma(overrides: any = {}) {
  const tx = {
    payment: {
      aggregate: vi.fn(async () => ({ _sum: { amountMinor: 500000 } })),
    },
    cashout: {
      findMany: vi.fn(async () => []),
      create: vi.fn(async ({ data }: any) => ({ id: 'co-new', ...data })),
    },
  };
  return {
    venue: { findUnique: vi.fn(async () => ({ id: 'venue-1' })) },
    payment: {
      aggregate: vi.fn(async () => ({ _sum: { amountMinor: 500000 } })),
      count: vi.fn(async () => 0),
    },
    order: {
      count: vi.fn(async () => 0),
    },
    cashout: {
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async () => null),
      findUnique: vi.fn(async () => null),
      create: vi.fn(async ({ data }: any) => ({ id: 'co-new', ...data })),
      update: vi.fn(async ({ where, data }: any) => ({ id: where.id, ...data })),
    },
    bankAccount: {
      findFirst: vi.fn(async () => ({ id: 'bank-1', providerRecipientCode: 'RCP_1', accountName: 'A', accountNumber: '1', bankCode: '011' })),
      count: vi.fn(async () => 1),
      create: vi.fn(async ({ data }: any) => ({ id: 'bank-2', ...data })),
      update: vi.fn(async ({ data }: any) => ({ id: 'bank-1', ...data })),
    },
    $transaction: vi.fn(async (fn: any) => fn(tx)),
    ...overrides,
  } as any;
}

function mockPaystack(overrides: any = {}) {
  return {
    isMock: () => false,
    initiateTransfer: vi.fn(async () => ({ transfer_code: 'TRF_1', reference: 'REF_1', amount: 100000, currency: 'NGN', status: 'pending' })),
    verifyTransfer: vi.fn(async () => ({ status: true, data: { status: 'success', transfer_code: 'TRF_1', amount: 100000, recipient: { name: 'A' } } })),
    createTransferRecipient: vi.fn(async () => ({ recipient_code: 'RCP_NEW', currency: 'NGN', active: true })),
    ...overrides,
  } as any;
}

describe('CashoutsService stability', () => {
  beforeEach(() => {
    process.env.OWNER_CASHOUT_PASSWORD = 'owner-secret';
    delete process.env.OWNER_CASHOUT_PASSWORD_HASH;
    delete process.env.ADMIN_PASSWORD_HASH;
  });

  it('computes balance as earned minus locked minus cashedOut', async () => {
    const prisma = mockPrisma({
      cashout: {
        findMany: vi.fn(async ({ where }: any) =>
          where.status === 'COMPLETED' ? [{ amountMinor: 50000 }] : [{ amountMinor: 100000 }],
        ),
        findFirst: vi.fn(async () => null),
        findUnique: vi.fn(async () => null),
        create: vi.fn(),
        update: vi.fn(),
      },
    });
    const svc = new CashoutsService(prisma, mockPaystack());
    const bal = await svc.venueBalance('venue-1');
    expect(bal.earnedMinor).toBe(500000);
    expect(bal.lockedMinor).toBe(100000);
    expect(bal.cashedOutMinor).toBe(50000);
    expect(bal.availableMinor).toBe(350000);
  });

  it('replays idempotent clientReference instead of double-paying', async () => {
    const prior = { id: 'co-old', status: 'COMPLETED', amountMinor: 100000 };
    const prisma = mockPrisma({
      cashout: {
        findMany: vi.fn(async () => []),
        findFirst: vi.fn(async () => null),
        findUnique: vi.fn(async () => prior),
        create: vi.fn(async () => { throw new Error('must not create'); }),
        update: vi.fn(),
      },
    });
    const svc = new CashoutsService(prisma, mockPaystack());
    const res = await svc.requestCashout({ venueId: 'venue-1', amountMinor: 100000, password: 'owner-secret', clientReference: 'cli-123' } as any);
    expect(res).toMatchObject({ id: 'co-old' });
  });

  it('rejects overdraw inside the atomic check', async () => {
    const prisma = mockPrisma();
    const svc = new CashoutsService(prisma, mockPaystack());
    await expect(
      svc.requestCashout({ venueId: 'venue-1', amountMinor: 999999999, password: 'owner-secret' } as any),
    ).rejects.toThrow('Insufficient available balance');
  });

  it('saves bank account with recipientPending when Paystack recipient fails', async () => {
    const prisma = mockPrisma();
    const paystack = mockPaystack({
      createTransferRecipient: vi.fn(async () => { throw new Error('invalid bank code'); }),
    });
    const svc = new CashoutsService(prisma, paystack);
    const res: any = await svc.registerBankAccount({
      venueId: 'venue-1', accountName: 'A', accountNumber: '0123456789', bankCode: '999', bankName: 'X',
    });
    expect(res.recipientPending).toBe(true);
    expect(res.providerRecipientCode).toBeNull();
  });

  it('self-heals missing recipient at cashout time', async () => {
    const prisma = mockPrisma({
      bankAccount: {
        findFirst: vi.fn(async () => ({ id: 'bank-1', providerRecipientCode: null, accountName: 'A', accountNumber: '1', bankCode: '011' })),
        count: vi.fn(async () => 1),
        create: vi.fn(),
        update: vi.fn(async ({ data }: any) => ({ id: 'bank-1', providerRecipientCode: 'RCP_NEW', ...data })),
      },
    });
    const paystack = mockPaystack();
    const svc = new CashoutsService(prisma, paystack);
    const res: any = await svc.requestCashout({ venueId: 'venue-1', amountMinor: 100000, password: 'owner-secret' } as any);
    expect(paystack.createTransferRecipient).toHaveBeenCalled();
    expect(res.status).toBe('COMPLETED');
  });

  it('reconcileProcessing finalizes stuck transfers', async () => {
    const prisma = mockPrisma({
      cashout: {
        findMany: vi.fn(async () => [
          { id: 'co-ok', status: 'PROCESSING', providerTransferCode: 'TRF_OK' },
          { id: 'co-fail', status: 'PROCESSING', providerTransferCode: 'TRF_BAD' },
          { id: 'co-flaky', status: 'PROCESSING', providerTransferCode: 'TRF_FLAKY' },
        ]),
        findFirst: vi.fn(async () => null),
        findUnique: vi.fn(async () => null),
        create: vi.fn(),
        update: vi.fn(async ({ where, data }: any) => ({ id: where.id, ...data })),
      },
    });
    const paystack = mockPaystack({
      verifyTransfer: vi.fn(async (code: string) => {
        if (code === 'TRF_OK') return { status: true, data: { status: 'success', transfer_code: code, amount: 1, recipient: { name: 'A' } } };
        if (code === 'TRF_BAD') return { status: true, data: { status: 'failed', transfer_code: code, amount: 1, recipient: { name: 'A' } } };
        throw new Error('network down');
      }),
    });
    const svc = new CashoutsService(prisma, paystack);
    const res = await svc.reconcileProcessing('venue-1');
    expect(res).toMatchObject({ checked: 3, finalized: 2, skipped: 1 });
  });
});

describe('CashoutsService policy engine', () => {
  beforeEach(() => {
    process.env.OWNER_CASHOUT_PASSWORD = 'owner-secret';
    delete process.env.OWNER_CASHOUT_PASSWORD_HASH;
    delete process.env.ADMIN_PASSWORD_HASH;
    delete process.env.CASHOUT_MIN_MINOR;
    delete process.env.CASHOUT_AUTO_MAX_MINOR;
    delete process.env.CASHOUT_DISPUTE_HOLD_DAYS;
  });

  it('rejects below minimum payout floor', async () => {
    process.env.CASHOUT_MIN_MINOR = '50000';
    const prisma = mockPrisma();
    const svc = new CashoutsService(prisma, mockPaystack());
    await expect(
      svc.requestCashout({ venueId: 'venue-1', amountMinor: 10000, password: 'owner-secret' } as any),
    ).rejects.toThrow('Below minimum payout');
  });

  it('holds large amounts for manual approval, then confirms', async () => {
    process.env.CASHOUT_AUTO_MAX_MINOR = '200000';
    const prisma = mockPrisma({
      cashout: {
        findMany: vi.fn(async () => []),
        findFirst: vi.fn(async () => null),
        findUnique: vi.fn(async ({ where }: any) => ({
          id: where.id,
          venueId: 'venue-1',
          amountMinor: 300000,
          status: 'PENDING',
          bankAccount: { id: 'bank-1', providerRecipientCode: 'RCP_1', accountName: 'A', accountNumber: '1', bankCode: '011' },
        })),
        create: vi.fn(async ({ data }: any) => ({ id: 'co-new', ...data })),
        update: vi.fn(async ({ where, data }: any) => ({ id: where.id, venueId: 'venue-1', amountMinor: 300000, status: 'PENDING', ...data })),
      },
    });
    const svc = new CashoutsService(prisma, mockPaystack());
    const held: any = await svc.requestCashout(
      { venueId: 'venue-1', amountMinor: 300000, password: 'owner-secret' } as any,
    );
    expect(held.status).toBe('PENDING');
    expect(held.requiresApproval).toBe(true);

    const done: any = await svc.confirmCashout({ cashoutId: held.id } as any, 'owner-secret');
    expect(done.status).toBe('COMPLETED');
  });

  it('holds on recent disputes even under the cap', async () => {
    const prisma = mockPrisma({
      payment: {
        aggregate: vi.fn(async () => ({ _sum: { amountMinor: 500000 } })),
        count: vi.fn(async () => 2),
      },
    });
    const svc = new CashoutsService(prisma, mockPaystack());
    const held: any = await svc.requestCashout(
      { venueId: 'venue-1', amountMinor: 100000, password: 'owner-secret' } as any,
    );
    expect(held.status).toBe('PENDING');
    expect(held.requiresApproval).toBe(true);
  });

  it('finalizes transfer webhooks: success, failed, reversed, duplicate, unknown', async () => {
    const prisma = mockPrisma({
      cashout: {
        findMany: vi.fn(async () => []),
        findFirst: vi.fn(async ({ where }: any) => {
          if (where.providerTransferCode === 'TRF_DONE') {
            return { id: 'co-done', status: 'COMPLETED', venueId: 'venue-1', amountMinor: 1000, bankAccount: {} };
          }
          if (where.providerTransferCode === 'TRF_1') {
            return { id: 'co-1', status: 'PROCESSING', venueId: 'venue-1', amountMinor: 100000, bankAccount: { accountName: 'A', accountNumber: '1' } };
          }
          return null;
        }),
        findUnique: vi.fn(async () => null),
        create: vi.fn(),
        update: vi.fn(async ({ where, data }: any) => ({ id: where.id, ...data })),
      },
    });
    const svc = new CashoutsService(prisma, mockPaystack());

    const ok: any = await svc.finalizeTransferEvent('TRF_1', 'success');
    expect(ok).toMatchObject({ ok: true, status: 'COMPLETED' });

    const fail: any = await svc.finalizeTransferEvent('TRF_1', 'failed');
    expect(fail).toMatchObject({ ok: true, status: 'FAILED' });

    const rev: any = await svc.finalizeTransferEvent('TRF_1', 'reversed');
    expect(rev).toMatchObject({ ok: true, status: 'REVERSED' });

    const dup: any = await svc.finalizeTransferEvent('TRF_DONE', 'success');
    expect(dup).toMatchObject({ ok: true, duplicate: true });

    const unknown: any = await svc.finalizeTransferEvent('TRF_NOPE', 'success');
    expect(unknown.ok).toBe(false);
  });
});
