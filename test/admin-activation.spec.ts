import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AdminService } from '../src/modules/admin/admin.service';

function mockPrisma() {
  const store = new Map<string, any>();
  const ledger: any[] = [];
  const api = {
    store,
    ledger,
    activationCode: {
      create: vi.fn(async ({ data }: any) => {
        const row = {
          id: `ac-${store.size + 1}`,
          ...data,
          createdAt: new Date(),
          status: data.status || 'AUTHORIZED',
        };
        store.set(row.code, row);
        return row;
      }),
      findUnique: vi.fn(async ({ where }: any) => store.get(where.code) || null),
      findFirst: vi.fn(async ({ where }: any) => {
        for (const row of store.values()) {
          if (where.status && row.status !== where.status) continue;
          if (where.redeemedBy && row.redeemedBy !== where.redeemedBy) continue;
          return row;
        }
        return null;
      }),
      findMany: vi.fn(async () => [...store.values()]),
      update: vi.fn(async ({ where, data }: any) => {
        const row = store.get(where.code);
        if (!row) throw new Error('Not found');
        const next = { ...row };
        for (const [k, v] of Object.entries(data as any)) {
          next[k] = v && typeof v === 'object' && 'increment' in (v as any)
            ? (row[k] || 0) + (v as any).increment
            : v;
        }
        store.set(where.code, next);
        return next;
      }),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    activationRedemption: {
      create: vi.fn(async ({ data }: any) => {
        if (ledger.some((l) => l.codeId === data.codeId && l.email === data.email)) {
          const err: any = new Error('Unique constraint');
          err.code = 'P2002';
          throw err;
        }
        const row = { id: `ar-${ledger.length + 1}`, redeemedAt: new Date(), ...data };
        ledger.push(row);
        return row;
      }),
      findFirst: vi.fn(async ({ where }: any) => {
        const matches = ledger.filter((l) => !where.email || l.email === where.email);
        if (!matches.length) return null;
        const latest = matches[matches.length - 1];
        const code = [...store.values()].find((r) => r.id === latest.codeId) || null;
        return { ...latest, code };
      }),
    },
  } as any;
  return api;
}

describe('AdminService Activation Codes (persistent, expiring)', () => {
  let service: AdminService;
  let prisma: any;

  beforeEach(() => {
    prisma = mockPrisma();
    service = new AdminService(prisma, {} as any, {} as any, {} as any);
  });

  it('generates activation codes in WP-ACT-XXXX-XXXX format', async () => {
    const res = await service.generateActivationCodes(3, 'Test Batch', 1, 'talk2icedmist@gmail.com');
    expect(res.ok).toBe(true);
    expect(res.count).toBe(3);
    for (const code of res.codes) {
      expect(code.code).toMatch(/^WP-ACT-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
      expect(code.status).toBe('AUTHORIZED');
      expect(code.quota).toBe(1);
    }
  });

  it('issues monthly batch per venue with shared expiry', async () => {
    const expiry = new Date(Date.now() + 30 * 86400000).toISOString();
    const res = await service.generateActivationCodes(
      1, 'September rotation', 1, 'talk2icedmist@gmail.com', expiry, ['venue-a', 'venue-b'],
    );
    expect(res.ok).toBe(true);
    expect(res.count).toBe(2);
    expect(res.codes[0].venueId).toBe('venue-a');
    expect(res.codes[1].venueId).toBe('venue-b');
    expect(res.codes[0].expiresAt).toBeDefined();
  });

  it('permanently activates talk2icedmist@gmail.com as super admin', async () => {
    const check = await service.checkAccountActivation('talk2icedmist@gmail.com');
    expect(check.ok).toBe(true);
    expect(check.activated).toBe(true);
    expect(check.role).toBe('system_admin');
  });

  it('checks unactivated accounts and redeems authorized activation code', async () => {
    const newEmail = 'shopowner@venue.com';
    expect((await service.checkAccountActivation(newEmail)).activated).toBe(false);

    const gen = await service.generateActivationCodes(1, 'Shop 1 Activation');
    const targetCode = gen.codes[0].code;

    const redeemRes = await service.redeemActivationCode(targetCode, newEmail, 'venue-uuid-123');
    expect(redeemRes.ok).toBe(true);
    expect(redeemRes.code!.status).toBe('USED');
    expect(redeemRes.code!.redeemedBy).toBe(newEmail);

    const secondRedeem = await service.redeemActivationCode(targetCode, 'another@venue.com');
    expect(secondRedeem.ok).toBe(false);
    expect(secondRedeem.error).toContain('already been redeemed');

    const checkAfter = await service.checkAccountActivation(newEmail);
    expect(checkAfter.activated).toBe(true);
    expect(checkAfter.code).toBe(targetCode);
  });

  it('allows system admin to revoke and re-authorize activation code', async () => {
    const gen = await service.generateActivationCodes(1, 'Revoke test');
    const targetCode = gen.codes[0].code;

    await service.authorizeActivationCode(targetCode, 'REVOKED');
    const redeemRevoked = await service.redeemActivationCode(targetCode, 'test@venue.com');
    expect(redeemRevoked.ok).toBe(false);
    expect(redeemRevoked.error).toContain('not authorized');

    await service.authorizeActivationCode(targetCode, 'AUTHORIZED');
    const redeemAuthorized = await service.redeemActivationCode(targetCode, 'test@venue.com');
    expect(redeemAuthorized.ok).toBe(true);
  });

  it('rejects expired codes on redeem and reports expiry on check', async () => {
    const past = new Date(Date.now() - 86400000).toISOString();
    const gen = await service.generateActivationCodes(1, 'Old batch', 1, 'talk2icedmist@gmail.com', past);
    const targetCode = gen.codes[0].code;

    const redeem = await service.redeemActivationCode(targetCode, 'late@venue.com');
    expect(redeem.ok).toBe(false);
    expect(redeem.error).toContain('expired');

    // Redeemed-then-expired account reads as deactivated with expired flag
    const future = new Date(Date.now() + 3600000).toISOString();
    const gen2 = await service.generateActivationCodes(1, 'Short code', 1, 'talk2icedmist@gmail.com', future);
    await service.redeemActivationCode(gen2.codes[0].code, 'short@venue.com');
    // force expiry
    const row = prisma.store.get(gen2.codes[0].code);
    row.expiresAt = new Date(Date.now() - 1000);
    const check = await service.checkAccountActivation('short@venue.com');
    expect(check.activated).toBe(false);
    expect(check.expired).toBe(true);
  });

  it('rejects venue-bound codes redeemed for a different venue', async () => {    const gen = await service.generateActivationCodes(
      1, 'Bound', 1, 'talk2icedmist@gmail.com', undefined, ['venue-a'],
    );
    const redeem = await service.redeemActivationCode(gen.codes[0].code, 'owner@venue.com', 'venue-b');
    expect(redeem.ok).toBe(false);
    expect(redeem.error).toContain('different venue');
  });

  it('issues LICENSE with 30d default, TRIAL with 7d default, MASTER lifetime', async () => {
    const lic = await service.generateActivationCodes(1, 'Lic', 1, 'talk2icedmist@gmail.com', undefined, undefined, 'LICENSE');
    const tri = await service.generateActivationCodes(1, 'Tri', 1, 'talk2icedmist@gmail.com', undefined, undefined, 'TRIAL');
    const mas = await service.generateActivationCodes(1, 'Mas', 5, 'talk2icedmist@gmail.com', undefined, undefined, 'MASTER');
    expect(lic.codes[0].kind).toBe('LICENSE');
    expect(tri.codes[0].kind).toBe('TRIAL');
    expect(mas.codes[0].kind).toBe('MASTER');
    const now = Date.now();
    expect(new Date(lic.codes[0].expiresAt).getTime()).toBeGreaterThan(now + 29 * 86400000);
    expect(new Date(tri.codes[0].expiresAt).getTime()).toBeGreaterThan(now + 6 * 86400000);
    expect(mas.codes[0].expiresAt).toBeNull();
    expect(mas.codes[0].quota).toBe(5);
  });

  it('MASTER codes are multi-use up to quota and activate each redeemer', async () => {
    const gen = await service.generateActivationCodes(1, 'Master batch', 2, 'talk2icedmist@gmail.com', undefined, undefined, 'MASTER');
    const code = gen.codes[0].code;
    const r1 = await service.redeemActivationCode(code, 'owner1@venue.com', 'venue-a');
    expect(r1.ok).toBe(true);
    expect(r1.code!.status).toBe('AUTHORIZED'); // quota remains
    expect((await service.checkAccountActivation('owner1@venue.com')).activated).toBe(true);
    const r2 = await service.redeemActivationCode(code, 'owner2@venue.com', 'venue-b');
    expect(r2.ok).toBe(true);
    expect(r2.code!.status).toBe('USED'); // quota exhausted
    // Earlier redeemer keeps activation via their own ledger grant
    expect((await service.checkAccountActivation('owner1@venue.com')).activated).toBe(true);
    expect((await service.checkAccountActivation('owner2@venue.com')).activated).toBe(true);
    const r3 = await service.redeemActivationCode(code, 'owner3@venue.com', 'venue-c');
    expect(r3.ok).toBe(false);
  });

  it('same account cannot burn MASTER quota twice', async () => {
    const gen = await service.generateActivationCodes(1, 'Master batch', 3, 'talk2icedmist@gmail.com', undefined, undefined, 'MASTER');
    const code = gen.codes[0].code;
    expect((await service.redeemActivationCode(code, 'owner@venue.com', 'venue-a')).ok).toBe(true);
    const again = await service.redeemActivationCode(code, 'owner@venue.com', 'venue-a');
    expect(again.ok).toBe(false);
    expect(again.error).toContain('already redeemed');
    expect(prisma.ledger.length).toBe(1);
  });

  it('custom durationDays overrides kind defaults', async () => {
    const gen = await service.generateActivationCodes(1, 'Long license', 1, 'talk2icedmist@gmail.com', undefined, undefined, 'LICENSE', 90);
    expect(new Date(gen.codes[0].expiresAt).getTime()).toBeGreaterThan(Date.now() + 89 * 86400000);
  });

  it('logs audit records and retrieves system health', async () => {
    await service.logAudit({
      action: 'ROUTER_REBOOT_TRIGGERED',
      category: 'ROUTER',
      actor: 'talk2icedmist@gmail.com',
      details: { routerId: 'r-1' },
      status: 'SUCCESS',
    });

    const audits = await service.getAuditLogs('ROUTER');
    expect(audits.ok).toBe(true);
    expect(audits.logs.some((l) => l.action === 'ROUTER_REBOOT_TRIGGERED')).toBe(true);

    const health = await service.getSystemHealth();
    expect(health.ok).toBe(true);
    expect(health.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(health.memory).toHaveProperty('rssMB');
  });
});
