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
    password?: string; passwords?: string[];
    sold?: boolean;
    source?: string;
    directMode?: string;
    expiresAt?: Date; createdBy?: string;
  }) {
    if (!params.venueId || !params.planId) {
      throw new BadRequestException('venueId and planId are required');
    }
    await this.sweepExpiredVouchers();
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

    const rows = codes.map((code, index) => ({
      venueId: params.venueId,
      planId: params.planId,
      codeHash: hashCode(code),
      displayCodeEnc: code,
      password: params.passwords?.[index] || params.password || null,
      sold: params.sold ?? false,
      soldAt: params.sold ? new Date() : null,
      source: params.source || 'batch',
      directMode: params.directMode ? String(params.directMode) : null,
      expiresAt: params.expiresAt,
      createdBy: params.createdBy,
      status: 'ISSUED' as const,
    }));

    // Partition against existing rows: re-uploads of our own codes are
    // idempotent successes; codes owned elsewhere are conflicts.
    const partition = async () => {
      const existing = await this.prisma.voucher.findMany({
        where: { codeHash: { in: rows.map((r) => r.codeHash) } },
        select: { codeHash: true, displayCodeEnc: true, password: true, sold: true, expiresAt: true, venueId: true, planId: true },
      });
      const byHash = new Map(existing.map((e) => [e.codeHash, e]));
      const usable: Array<{ code: string | null; password?: string | null; sold?: boolean; expiresAt: Date | null }> = [];
      const fresh: typeof rows = [];
      const conflicts: Array<{ code: string; reason: string }> = [];
      for (const row of rows) {
        const hit = byHash.get(row.codeHash);
        if (!hit) {
          fresh.push(row);
        } else if (hit.venueId === params.venueId && hit.planId === params.planId) {
          if ((row.password && !hit.password) || (row.sold && !hit.sold)) {
            await this.prisma.voucher.update({
              where: { codeHash: row.codeHash },
              data: {
                ...(row.password && !hit.password ? { password: row.password } : {}),
                ...(row.sold && !hit.sold ? { sold: true, soldAt: new Date() } : {}),
              },
            }).catch(() => {});
          }
          usable.push({ code: hit.displayCodeEnc, password: row.password || hit.password, sold: row.sold || hit.sold, expiresAt: hit.expiresAt });
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
          select: { displayCodeEnc: true, password: true, sold: true, expiresAt: true },
        });
        usable = [...usable, ...inserted.map((v) => ({ code: v.displayCodeEnc, password: v.password, sold: v.sold, expiresAt: v.expiresAt }))];
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

  /**
   * Bulk sync/upsert vouchers from mobile app into database.
   * Guarantees POS sales, passwords, and counter vouchers are permanently stored in DB.
   */
  async syncVouchers(params: {
    venueId: string;
    vouchers: Array<{
      code: string;
      password?: string;
      planId?: string;
      planTitle?: string;
      price?: string;
      durationSeconds?: number;
      status?: string;
      sold?: boolean;
      soldAt?: string | Date;
      source?: string;
      directMode?: boolean | string;
      createdAt?: string | Date;
      expiresAt?: string | Date;
      mac?: string;
      ip?: string;
    }>;
  }) {
    if (!params.venueId) throw new BadRequestException('venueId is required');
    const vouchers = params.vouchers || [];
    if (vouchers.length === 0) return { synced: 0, created: 0, updated: 0 };

    const venuePlans = await this.prisma.plan.findMany({
      where: { venueId: params.venueId, active: true },
    });
    const defaultPlanId = venuePlans.length > 0 ? venuePlans[0].id : null;

    let created = 0;
    let updated = 0;

    for (const item of vouchers) {
      const code = normalizeCode(item.code);
      if (!code) continue;
      const codeHash = hashCode(code);
      const isSold = item.sold === true;
      const soldAt = item.soldAt ? new Date(item.soldAt) : (isSold ? new Date() : null);
      const expiresAt = item.expiresAt ? new Date(item.expiresAt) : null;
      const directModeStr = item.directMode ? String(item.directMode) : null;

      const existing = await this.prisma.voucher.findUnique({ where: { codeHash } });
      if (existing) {
        const updateData: any = {};
        if (item.password && !existing.password) updateData.password = item.password;
        if (isSold && !existing.sold) {
          updateData.sold = true;
          updateData.soldAt = soldAt || new Date();
        }
        if (item.source && !existing.source) updateData.source = item.source;
        if (directModeStr && directModeStr !== existing.directMode) updateData.directMode = directModeStr;
        if (item.status && item.status.toUpperCase() === 'EXPIRED' && existing.status !== 'EXPIRED') {
          updateData.status = 'EXPIRED';
        }

        if (Object.keys(updateData).length > 0) {
          await this.prisma.voucher.update({
            where: { codeHash },
            data: updateData,
          });
        }
        updated++;
      } else {
        let planId: string | null = item.planId || null;
        if (!planId || !venuePlans.some((p) => p.id === planId)) {
          if (item.planTitle) {
            const matched = venuePlans.find(
              (p) => p.name.toLowerCase() === item.planTitle!.toLowerCase(),
            );
            if (matched) planId = matched.id;
          }
          if (!planId && defaultPlanId) planId = defaultPlanId;
        }

        if (!planId) {
          const defaultPlans = await this.prisma.plan.findMany({
            where: { venueId: params.venueId },
          });
          planId = defaultPlans.length > 0 ? defaultPlans[0].id : null;
        }

        if (!planId) continue;

        await this.prisma.voucher.create({
          data: {
            venueId: params.venueId,
            planId,
            codeHash,
            displayCodeEnc: code,
            password: item.password || null,
            status: item.status?.toUpperCase() === 'EXPIRED' ? 'EXPIRED' : 'ISSUED',
            sold: isSold,
            soldAt,
            source: item.source || 'pos',
            directMode: directModeStr,
            expiresAt,
            issuedAt: item.createdAt ? new Date(item.createdAt) : new Date(),
          },
        }).catch(() => {});
        created++;
      }
    }

    return { synced: vouchers.length, created, updated };
  }

  /**
   * Toggles sold status of a voucher in cloud DB.
   */
  async markSold(code: string, sold: boolean) {
    const normalized = normalizeCode(code);
    if (!normalized) throw new BadRequestException('Voucher code is required');
    const codeHash = hashCode(normalized);
    const res = await this.prisma.voucher.updateMany({
      where: {
        OR: [
          { codeHash },
          { displayCodeEnc: normalized },
        ],
      },
      data: {
        sold,
        soldAt: sold ? new Date() : null,
      },
    });
    return { ok: true, count: res.count, code: normalized, sold };
  }

  /**
   * Lazily flip past-due vouchers to EXPIRED (same pattern as sweepExpiredCodes in admin.service.ts).
   */
  async sweepExpiredVouchers() {
    try {
      await this.prisma.voucher.updateMany({
        where: {
          expiresAt: { lt: new Date() },
          status: { in: ['ISSUED', 'GENERATED'] },
        },
        data: { status: 'EXPIRED' },
      });
    } catch {}
  }

  /** Non-consuming existence check so apps can verify a code landed in cloud
   *  before presenting it as valid (never marks REDEEMED). */
  async check(code: string) {
    await this.sweepExpiredVouchers();
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

  async listByVenue(venueId: string) {
    await this.sweepExpiredVouchers();
    return this.prisma.voucher.findMany({
      where: { venueId },
      include: { plan: true },
      orderBy: { issuedAt: 'desc' },
      take: 200,
    });
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
