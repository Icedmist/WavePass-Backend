import { ConflictException, GoneException, Injectable, NotFoundException } from '@nestjs/common';
import { randomBytes, createHash, randomInt } from 'crypto';
import { PrismaService } from '../../common/prisma.service';
import { MikrotikProvisioningQueue } from '../mikrotik/mikrotik-provisioning.queue';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I ambiguity

function humanCode(): string {
  const groups = Array.from({ length: 3 }, () =>
    Array.from({ length: 4 }, () => ALPHABET[randomInt(ALPHABET.length)]).join(''),
  );
  return groups.join('-');
}

function normalizeCode(code: string): string {
  return (code || '').trim().toUpperCase().replace(/\s+/g, '');
}

function hashCode(code: string): string {
  return createHash('sha256').update(normalizeCode(code)).digest('hex');
}

@Injectable()
export class VouchersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly provisioningQueue: MikrotikProvisioningQueue,
  ) {}

  /** Batch generation is idempotent via a caller-supplied idempotencyKey (not modeled here — enforce via unique constraint on a batch table, or dedupe at the queue/job layer). */
  async generateBatch(params: { venueId: string; planId: string; quantity: number; expiresAt?: Date; createdBy?: string }) {
    const vouchers = Array.from({ length: params.quantity }, () => {
      const code = humanCode();
      return {
        venueId: params.venueId,
        planId: params.planId,
        codeHash: hashCode(code),
        // In production, encrypt `code` with ENCRYPTION_KEY for reprint retrieval
        // rather than storing plaintext. Omitted here for scaffold brevity.
        displayCodeEnc: code,
        expiresAt: params.expiresAt,
        createdBy: params.createdBy,
        status: 'ISSUED' as const,
      };
    });

    await this.prisma.voucher.createMany({ data: vouchers });
    return vouchers.map((v) => ({ code: v.displayCodeEnc, expiresAt: v.expiresAt }));
  }

  /** Atomic single-use redemption. Two concurrent attempts cannot both succeed (PRD §23). */
  async redeem(code: string, ctx: { deviceId?: string; ip?: string; mac?: string; routerId: string }) {
    const normalized = normalizeCode(code);
    const codeHash = hashCode(normalized);
    const mac = ctx.mac?.toUpperCase().trim();

    const voucher = await this.prisma.$transaction(async (tx) => {
      // Row lock via a conditional update: only one caller can flip GENERATED/ISSUED -> REDEEMED.
      // Try exact hash first, then dash-insensitive fallback (user typed code without dashes).
      let v = await tx.voucher.findUnique({ where: { codeHash } });
      if (!v) {
        const stripped = normalized.replace(/-/g, '');
        const candidates = await (tx.voucher as any).findMany({
          where: { displayCodeEnc: { not: null } },
          select: { id: true, displayCodeEnc: true },
          take: 500,
        }).catch(() => []);
        const match = (candidates as any[]).find(
          (c) => (c.displayCodeEnc || '').toUpperCase().replace(/[\s-]/g, '') === stripped,
        );
        if (match) v = await tx.voucher.findUnique({ where: { id: match.id } });
      }
      if (!v) throw new NotFoundException('Invalid voucher code');
      if (v.status === 'REVOKED') throw new GoneException('Voucher has been revoked');
      if (v.status === 'EXPIRED' || (v.expiresAt && v.expiresAt < new Date())) {
        throw new GoneException('Voucher has expired');
      }
      // Checkout-issued vouchers are already ACTIVE — claiming = returning credentials, not re-redeeming.
      if (v.status === 'ACTIVE') {
        const expiry = v.expiresAt ? v.expiresAt.getTime() : 0;
        if (v.expiresAt && expiry < Date.now()) throw new GoneException('Voucher has expired');
        return v;
      }
      // Idempotent re-claim from same device
      if (v.status === 'REDEEMED' && mac && v.redeemedMac === mac) {
        return v;
      }
      if (v.status !== 'ISSUED' && v.status !== 'GENERATED') {
        throw new ConflictException('Voucher already redeemed');
      }

      const updated = await tx.voucher.updateMany({
        where: { codeHash: v.codeHash, status: v.status }, // optimistic guard — fails if status changed under us
        data: {
          status: 'REDEEMED',
          redeemedAt: new Date(),
          redeemedDeviceId: ctx.deviceId,
          redeemedIp: ctx.ip,
          redeemedMac: mac,
        },
      });
      if (updated.count === 0) throw new ConflictException('Voucher already redeemed');

      return tx.voucher.findUniqueOrThrow({ where: { codeHash: v.codeHash } });
    });

    await this.provisioningQueue.enqueue({ voucherId: voucher.id });
    return { voucherId: voucher.id, planId: voucher.planId, status: 'redeemed' };
  }

  async revoke(voucherId: string) {
    return this.prisma.voucher.update({
      where: { id: voucherId },
      data: { status: 'REVOKED', revokedAt: new Date() },
    });
  }
}
