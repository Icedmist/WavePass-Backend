import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'crypto';
import { VouchersService } from '../src/modules/vouchers/vouchers.service';

function mockPrisma(row: any) {
  let current: any = row ? { ...row } : null;
  const tx: any = {
    voucher: {
      findUnique: vi.fn(async ({ where }: any) => {
        if (where.codeHash && current && current.codeHash === where.codeHash) return { ...current };
        if (where.id && current && current.id === where.id) return { ...current };
        return null;
      }),
      findUniqueOrThrow: vi.fn(async ({ where }: any) => {
        if (where.codeHash && current && current.codeHash === where.codeHash) return { ...current };
        if (where.id && current && current.id === where.id) return { ...current };
        throw new Error('Not found');
      }),
      findMany: vi.fn(async () => []),
      updateMany: vi.fn(async ({ where, data }: any) => {
        if (current && current.codeHash === where.codeHash && current.status === where.status) {
          current = { ...current, ...data };
          return { count: 1 };
        }
        return { count: 0 };
      }),
    },
  };
  return {
    $transaction: vi.fn(async (fn: any) => fn(tx)),
    get current() {
      return current;
    },
  } as any;
}

const hashOf = (code: string) => createHash('sha256').update(code.toUpperCase().trim()).digest('hex');

function activeRow() {
  return {
    id: 'v-1', venueId: 'venue-1', planId: 'plan-1',
    codeHash: hashOf('123456'), displayCodeEnc: '123456',
    status: 'ACTIVE', issuedAt: new Date(), redeemedAt: new Date(),
    expiresAt: new Date(Date.now() + 3600000),
    redeemedMac: null, redeemedDeviceId: null,
  };
}

describe('VouchersService.redeem ACTIVE lifecycle', () => {
  it('flips ACTIVE to REDEEMED with firstLoginAt + device binding on first use', async () => {
    const prisma = mockPrisma(activeRow());
    const queue: any = { enqueue: vi.fn(async () => ({})) };
    const svc = new VouchersService(prisma, queue);

    const res = await svc.redeem('123456', {
      routerId: 'r1', mac: 'AA:BB:CC:DD:EE:FF', deviceId: 'AA:BB:CC:DD:EE:FF',
    });
    expect(res.status).toBe('redeemed');
    expect(prisma.current.status).toBe('REDEEMED');
    expect(prisma.current.firstLoginAt).toBeDefined();
    expect(queue.enqueue).toHaveBeenCalledWith({ voucherId: 'v-1' });
  });

  it('same-device reclaim stays idempotent', async () => {
    const prisma = mockPrisma(activeRow());
    const queue: any = { enqueue: vi.fn(async () => ({})) };
    const svc = new VouchersService(prisma, queue);

    await svc.redeem('123456', { routerId: 'r1', mac: 'AA:BB:CC:DD:EE:FF' });
    const res = await svc.redeem('123456', { routerId: 'r1', mac: 'AA:BB:CC:DD:EE:FF' });
    expect(res.status).toBe('redeemed');
  });
});
