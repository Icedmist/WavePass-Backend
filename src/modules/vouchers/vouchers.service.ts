import { BadRequestException, ConflictException, GoneException, Injectable, NotFoundException } from '@nestjs/common';
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

  /**
   * Batch generation. Honors caller-supplied codes so the cloud record matches
   * what staff print and what the router holds:
   *  - customCodes[] (bulk) or customCode (single) are stored verbatim
   *    (normalized); otherwise random codes are generated.
   *  - Bulk inserts skip duplicates and report created vs requested counts.
   *  - A single custom-code collision throws 409 so the caller regenerates.
   */
  async generateBatch(params: {
    venueId: string; planId: string; quantity: number;
    customCode?: string; customCodes?: string[];
    expiresAt?: Date; createdBy?: string;
  }) {
    if (!params.venueId || !params.planId) {
      throw new BadRequestException('venueId and planId are required');
    }
    const qty = Math.min(Math.max(Math.floor(params.quantity || 0), 1), 500);

    let codes: string[];
    if (params.customCodes && params.customCodes.length > 0) {
      codes = params.customCodes.slice(0, 500).map(normalizeCode).filter((c) => c.length > 0);
      if (codes.length === 0) throw new BadRequestException('No usable custom codes supplied');
    } else if (params.customCode && normalizeCode(params.customCode).length > 0) {
      codes = [normalizeCode(params.customCode)];
    } else {
      codes = Array.from({ length: qty }, () => humanCode());
    }
    // De-duplicate within the request (same code twice would P2002 the batch).
    codes = [...new Set(codes)];

    const rows = codes.map((code) => ({
      venueId: params.venueId,
      planId: params.planId,
      codeHash: hashCode(code),
      // In production, encrypt `code` with ENCRYPTION_KEY for reprint retrieval
      // rather than storing plaintext. Omitted here for scaffold brevity.
      displayCodeEnc: code,
      expiresAt: params.expiresAt,
      createdBy: params.createdBy,
      status: 'ISSUED' as const,
    }));

    // Partition against existing rows: re-uploads of our own codes are
    // idempotent successes; codes owned elsewhere are conflicts.
    const partition = async () => {
      const existing = await this.prisma.voucher.findMany({
        where: { codeHash: { in: rows.map((r) => r.codeHash) } },
        select: { codeHash: true, displayCodeEnc: true, expiresAt: true, venueId: true, planId: true },
      });
      const byHash = new Map(existing.map((e) => [e.codeHash, e]));
      const usable: Array<{ code: string | null; expiresAt: Date | null }> = [];
      const fresh: typeof rows = [];
      const conflicts: Array<{ code: string; reason: string }> = [];
      for (const row of rows) {
        const hit = byHash.get(row.codeHash);
        if (!hit) {
          fresh.push(row);
        } else if (hit.venueId === params.venueId && hit.planId === params.planId) {
          usable.push({ code: hit.displayCodeEnc, expiresAt: hit.expiresAt });
        } else {
          conflicts.push({ code: row.displayCodeEnc!, reason: 'code already exists for another venue/plan' });
        }
      }
      return { usable, fresh, conflicts };
    };

    let { usable, fresh, conflicts } = await partition();
    if (fresh.length > 0) {
      try {
        await this.prisma.voucher.createMany({ data: fresh });
        const inserted = await this.prisma.voucher.findMany({
          where: { codeHash: { in: fresh.map((r) => r.codeHash) } },
          select: { displayCodeEnc: true, expiresAt: true },
        });
        usable = [...usable, ...inserted.map((v) => ({ code: v.displayCodeEnc, expiresAt: v.expiresAt }))];
      } catch (err: any) {
        if (err.code === 'P2002') {
          if (rows.length === 1) {
            throw new ConflictException('Voucher code already exists — generate a new one');
          }
          // Lost a bulk race — re-partition once and accept the outcome.
          const retry = await partition();
          usable = retry.usable;
          conflicts = retry.conflicts;
        } else {
          throw err;
        }
      }
    }

    if (rows.length === 1 && conflicts.length > 0) {
      throw new ConflictException('Voucher code already exists — generate a new one');
    }

    return {
      vouchers: usable,
      requested: codes.length,
      created: usable.length,
      conflicts,
    };
  }

  /** Non-consuming existence check so apps can verify a code landed in cloud
   *  before presenting it as valid (never marks REDEEMED). */
  async check(code: string) {
    const normalized = normalizeCode(code);
    if (!normalized) throw new BadRequestException('Voucher code is required');
    const codeHash = hashCode(normalized);
    const v = await this.prisma.voucher.findUnique({
      where: { codeHash },
      include: { plan: { select: { name: true } }, venue: { select: { id: true, name: true } } },
    });
    if (!v) return { exists: false, code: normalized };
    return {
      exists: true,
      code: v.displayCodeEnc || normalized,
      status: v.status,
      planName: (v as any).plan?.name || null,
      venueId: v.venueId,
      venueName: (v as any).venue?.name || null,
      expiresAt: v.expiresAt,
    };
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
      // Checkout-issued vouchers arrive ACTIVE — first real use flips them to
      // REDEEMED with device binding (PRD §10). Concurrent first claims race
      // on the conditional guard; same-device losers stay idempotent.
      if (v.status === 'ACTIVE') {
        const expiry = v.expiresAt ? v.expiresAt.getTime() : 0;
        if (v.expiresAt && expiry < Date.now()) throw new GoneException('Voucher has expired');
        // Already claimed by this device — idempotent return.
        if (mac && v.redeemedMac === mac) return v;
        if (!mac && !ctx.deviceId && !ctx.ip) return v;
        const claimed = await tx.voucher.updateMany({
          where: { codeHash: v.codeHash, status: 'ACTIVE' },
          data: {
            status: 'REDEEMED',
            redeemedAt: new Date(),
            firstLoginAt: new Date(),
            redeemedDeviceId: ctx.deviceId || mac,
            redeemedIp: ctx.ip,
            redeemedMac: mac || v.redeemedMac,
          },
        });
        if (claimed.count === 0) {
          const current = await tx.voucher.findUniqueOrThrow({ where: { codeHash: v.codeHash } });
          if (mac && current.redeemedMac === mac) return current;
          throw new ConflictException('Voucher already redeemed');
        }
        return tx.voucher.findUniqueOrThrow({ where: { codeHash: v.codeHash } });
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
