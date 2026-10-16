import { describe, it, expect, vi } from 'vitest';
import { VouchersService } from '../src/modules/vouchers/vouchers.service';

function mockPrisma() {
  const store = new Map<string, any>();
  return {
    store,
    voucher: {
      createMany: vi.fn(async ({ data }: any) => {
        for (const row of data) {
          if ([...store.values()].some((r) => r.codeHash === row.codeHash)) {
            const err: any = new Error('Unique constraint');
            err.code = 'P2002';
            throw err;
          }
        }
        for (const row of data) store.set(row.codeHash, { id: `v-${store.size + 1}`, ...row });
        return { count: data.length };
      }),
      create: vi.fn(async ({ data }: any) => {
        const item = { id: `v-${store.size + 1}`, ...data };
        store.set(data.codeHash, item);
        return item;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const current = store.get(where.codeHash);
        const updated = { ...current, ...data };
        store.set(where.codeHash, updated);
        return updated;
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        let count = 0;
        for (const [key, v] of store.entries()) {
          if (where?.expiresAt?.lt && (!v.expiresAt || new Date(v.expiresAt) >= new Date())) {
            continue;
          }
          if (where?.codeHash && v.codeHash !== where.codeHash) {
            continue;
          }
          store.set(key, { ...v, ...data });
          count++;
        }
        return { count };
      }),
      findMany: vi.fn(async ({ where }: any) => {
        const hashes: string[] = where?.codeHash?.in || [];
        if (hashes.length > 0) {
          return [...store.values()].filter((r) => hashes.includes(r.codeHash));
        }
        return [...store.values()];
      }),
      findUnique: vi.fn(async ({ where }: any) => store.get(where.codeHash) || null),
    },
    plan: {
      findMany: vi.fn(async () => [{ id: 'plan-1', name: 'Standard' }]),
    },
  } as any;
}

describe('VouchersService.generateBatch custom codes', () => {
  it('stores the caller-supplied customCode verbatim', async () => {
    const prisma = mockPrisma();
    const svc = new VouchersService(prisma, {} as any);
    const res = await svc.generateBatch({
      venueId: 'venue-1', planId: 'plan-1', quantity: 1, customCode: '482910',
    });
    expect(res.requested).toBe(1);
    expect(res.created).toBe(1);
    expect(res.vouchers[0].code).toBe('482910');
  });

  it('stores bulk customCodes and reports counts', async () => {
    const prisma = mockPrisma();
    const svc = new VouchersService(prisma, {} as any);
    const res = await svc.generateBatch({
      venueId: 'venue-1', planId: 'plan-1', quantity: 3,
      customCodes: ['AAA111', 'BBB222', 'CCC333'],
    });
    expect(res.requested).toBe(3);
    expect(res.created).toBe(3);
    expect(res.vouchers.map((v: any) => v.code).sort()).toEqual(['AAA111', 'BBB222', 'CCC333']);
  });

  it('409s on single custom-code collision', async () => {
    const prisma = mockPrisma();
    const svc = new VouchersService(prisma, {} as any);
    // Seed a conflicting code owned by ANOTHER venue directly
    const otherHash = (await import('crypto')).createHash('sha256').update('482910').digest('hex');
    prisma.store.set(otherHash, {
      id: 'v-other', venueId: 'venue-X', planId: 'plan-X', codeHash: otherHash,
      displayCodeEnc: '482910', status: 'ISSUED',
    });
    await expect(
      svc.generateBatch({ venueId: 'venue-1', planId: 'plan-1', quantity: 1, customCode: '482910' }),
    ).rejects.toThrow('already exists');
  });

  it('treats re-upload of own codes as idempotent success', async () => {
    const prisma = mockPrisma();
    const svc = new VouchersService(prisma, {} as any);
    const first = await svc.generateBatch({
      venueId: 'venue-1', planId: 'plan-1', quantity: 2, customCodes: ['AAA111', 'BBB222'],
    });
    expect(first.created).toBe(2);
    const second = await svc.generateBatch({
      venueId: 'venue-1', planId: 'plan-1', quantity: 2, customCodes: ['AAA111', 'BBB222'],
    });
    expect(second.created).toBe(2);
    expect(second.conflicts).toEqual([]);
  });

  it('still generates random codes when none supplied', async () => {
    const prisma = mockPrisma();
    const svc = new VouchersService(prisma, {} as any);
    const res = await svc.generateBatch({ venueId: 'venue-1', planId: 'plan-1', quantity: 2 });
    expect(res.created).toBe(2);
    expect(res.vouchers[0].code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  });
});

describe('VouchersService.check (non-consuming)', () => {
  it('returns existence without mutating status', async () => {
    const prisma = mockPrisma();
    const svc = new VouchersService(prisma, {} as any);
    await svc.generateBatch({ venueId: 'venue-1', planId: 'plan-1', quantity: 1, customCode: '482910' });

    const found: any = await svc.check('482910');
    expect(found.exists).toBe(true);
    expect(found.code).toBe('482910');
    expect(found.status).toBe('ISSUED');

    const missing: any = await svc.check('000000');
    expect(missing.exists).toBe(false);

    // Status untouched by check
    const again: any = await svc.check('482910');
    expect(again.status).toBe('ISSUED');
  });
});

describe('VouchersService.generateBatch with passwords & metadata', () => {
  it('stores passwords and sold status when provided', async () => {
    const prisma = mockPrisma();
    const svc = new VouchersService(prisma, {} as any);
    const res = await svc.generateBatch({
      venueId: 'venue-1',
      planId: 'plan-1',
      quantity: 1,
      customCode: 'V100',
      password: 'PIN-999',
      sold: true,
      source: 'pos',
    });
    expect(res.created).toBe(1);
    expect(res.vouchers[0].password).toBe('PIN-999');
    expect(res.vouchers[0].sold).toBe(true);
  });
});

describe('VouchersService.syncVouchers', () => {
  it('upserts mobile vouchers with password and sold status', async () => {
    const prisma = mockPrisma();
    const svc = new VouchersService(prisma, {} as any);
    const res = await svc.syncVouchers({
      venueId: 'venue-1',
      vouchers: [
        { code: 'SYNC-1', password: 'PASS-1', planTitle: 'Standard', sold: true, source: 'pos' },
        { code: 'SYNC-2', password: 'PASS-2', planTitle: 'Standard', sold: false, source: 'batch' },
      ],
    });
    expect(res.synced).toBe(2);
    expect(res.created).toBe(2);

    // Re-syncing same codes should update without errors
    const res2 = await svc.syncVouchers({
      venueId: 'venue-1',
      vouchers: [
        { code: 'SYNC-1', password: 'PASS-1', sold: true },
      ],
    });
    expect(res2.updated).toBe(1);
  });
});

describe('VouchersService.markSold', () => {
  it('toggles sold flag in database', async () => {
    const prisma = mockPrisma();
    const svc = new VouchersService(prisma, {} as any);
    await svc.generateBatch({ venueId: 'venue-1', planId: 'plan-1', quantity: 1, customCode: 'SOLD-1' });

    const res = await svc.markSold('SOLD-1', true);
    expect(res.ok).toBe(true);
    expect(res.sold).toBe(true);
  });
});

