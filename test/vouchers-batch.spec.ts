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
      findMany: vi.fn(async ({ where }: any) => {
        const hashes: string[] = where?.codeHash?.in || [];
        return [...store.values()].filter((r) => hashes.includes(r.codeHash));
      }),
      findUnique: vi.fn(async ({ where }: any) => store.get(where.codeHash) || null),
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
