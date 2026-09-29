import { describe, it, expect, vi } from 'vitest';
import { VouchersService } from '../src/modules/vouchers/vouchers.service';
import { ConflictException, GoneException, NotFoundException } from '@nestjs/common';
import { createHash } from 'crypto';

const hashOf = (code: string) => createHash('sha256').update(code.toUpperCase().trim()).digest('hex');

describe('VouchersService extra unit tests', () => {
  it('listByVenue sweeps expired vouchers and returns vouchers for the given venue', async () => {
    let swept = false;
    const vouchers = [
      { id: 'v-1', venueId: 'venue-1', status: 'ISSUED', plan: { name: '1 Hour' } },
      { id: 'v-2', venueId: 'venue-1', status: 'ACTIVE', plan: { name: '2 Hours' } },
    ];
    const prisma: any = {
      voucher: {
        updateMany: vi.fn(async () => {
          swept = true;
          return { count: 0 };
        }),
        findMany: vi.fn(async ({ where, include, orderBy, take }: any) => {
          if (where.venueId === 'venue-1') return vouchers;
          return [];
        }),
      },
    };

    const svc = new VouchersService(prisma, {} as any);
    const res = await svc.listByVenue('venue-1');

    expect(swept).toBe(true);
    expect(res).toHaveLength(2);
    expect(prisma.voucher.findMany).toHaveBeenCalledWith({
      where: { venueId: 'venue-1' },
      include: { plan: true },
      orderBy: { issuedAt: 'desc' },
      take: 200,
    });
  });

  it('revoke updates voucher status to REVOKED with timestamp', async () => {
    const prisma: any = {
      voucher: {
        update: vi.fn(async ({ where, data }: any) => ({
          id: where.id,
          ...data,
        })),
      },
    };

    const svc = new VouchersService(prisma, {} as any);
    const res = await svc.revoke('v-target');

    expect(res.id).toBe('v-target');
    expect(res.status).toBe('REVOKED');
    expect(res.revokedAt).toBeInstanceOf(Date);
  });

  describe('redeem edge cases and exceptions', () => {
    it('throws NotFoundException when voucher code does not exist', async () => {
      const tx: any = {
        voucher: {
          findUnique: vi.fn(async () => null),
          findMany: vi.fn(async () => []),
        },
      };
      const prisma: any = {
        $transaction: vi.fn(async (fn: any) => fn(tx)),
      };

      const svc = new VouchersService(prisma, {} as any);
      await expect(
        svc.redeem('NONEXISTENT', { routerId: 'r1' }),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws GoneException when voucher status is REVOKED', async () => {
      const row = {
        id: 'v-revoked',
        codeHash: hashOf('REVOKED-CODE'),
        status: 'REVOKED',
      };
      const tx: any = {
        voucher: {
          findUnique: vi.fn(async () => row),
          findMany: vi.fn(async () => []),
        },
      };
      const prisma: any = {
        $transaction: vi.fn(async (fn: any) => fn(tx)),
      };

      const svc = new VouchersService(prisma, {} as any);
      await expect(
        svc.redeem('REVOKED-CODE', { routerId: 'r1' }),
      ).rejects.toThrow(GoneException);
    });

    it('throws GoneException when voucher is past expiry date', async () => {
      const row = {
        id: 'v-expired',
        codeHash: hashOf('EXPIRED-CODE'),
        status: 'ISSUED',
        expiresAt: new Date(Date.now() - 60000), // 1 min in past
      };
      const tx: any = {
        voucher: {
          findUnique: vi.fn(async () => row),
          findMany: vi.fn(async () => []),
        },
      };
      const prisma: any = {
        $transaction: vi.fn(async (fn: any) => fn(tx)),
      };

      const svc = new VouchersService(prisma, {} as any);
      await expect(
        svc.redeem('EXPIRED-CODE', { routerId: 'r1' }),
      ).rejects.toThrow(GoneException);
    });

    it('throws ConflictException when voucher status is not ISSUED or GENERATED', async () => {
      const row = {
        id: 'v-used',
        codeHash: hashOf('USED-CODE'),
        status: 'REDEEMED',
        redeemedMac: '11:22:33:44:55:66',
      };
      const tx: any = {
        voucher: {
          findUnique: vi.fn(async () => row),
          findMany: vi.fn(async () => []),
        },
      };
      const prisma: any = {
        $transaction: vi.fn(async (fn: any) => fn(tx)),
      };

      const svc = new VouchersService(prisma, {} as any);
      // Different MAC attempting to redeem
      await expect(
        svc.redeem('USED-CODE', { routerId: 'r1', mac: '99:88:77:66:55:44' }),
      ).rejects.toThrow(ConflictException);
    });
  });
});
