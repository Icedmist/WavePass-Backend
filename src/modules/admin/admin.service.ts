import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';
import { PaystackService } from '../paystack/paystack.service';
import { MikrotikProvisioningQueue } from '../mikrotik/mikrotik-provisioning.queue';
import { VenuesService } from '../venues/venues.service';
import { CashoutsService } from '../cashouts/cashouts.service';

@Injectable()
export class AdminService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AdminService.name);
  private cleanupTimer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly paystack: PaystackService,
    private readonly venuesService: VenuesService,
    private readonly provisioningQueue: MikrotikProvisioningQueue,
    private readonly cashouts?: CashoutsService,
  ) {}

  onModuleInit() {
    // Run automated session sweep every 60 seconds
    this.cleanupTimer = setInterval(() => {
      this.cleanup().catch((err) => {
        this.logger.debug(`Automated session cleanup error: ${err.message}`);
      });
    }, 60000);
  }

  onModuleDestroy() {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
  }

  async getStats() {
    const allPayments = await this.prisma.payment.findMany({
      include: { order: { include: { plan: true } } },
    });

    const success = allPayments.filter((p) => p.status === 'FULFILLED' || p.status === 'SUCCESS');
    const pending = allPayments.filter((p) => p.status === 'PENDING' || p.status === 'CREATED');

    const totalRevenueKobo = success.reduce((acc, p) => acc + p.amountMinor, 0);
    const totalRevenueNGN = Math.round(totalRevenueKobo / 100);
    const arpuNGN = success.length > 0 ? Math.round(totalRevenueNGN / success.length) : 0;

    const byPlan: Record<string, { count: number; revenueNGN: number }> = {};
    for (const p of success) {
      const planName = p.order?.plan?.name || p.order?.planId || 'Unknown Plan';
      if (!byPlan[planName]) byPlan[planName] = { count: 0, revenueNGN: 0 };
      byPlan[planName].count++;
      byPlan[planName].revenueNGN += Math.round(p.amountMinor / 100);
    }

    const defaultVenue = await this.venuesService.getDefaultVenue();
    const router = defaultVenue.routers[0];

    let routerStats = { total: 0, active: 0, expired: 0 };
    if (router) {
      try {
        const res = await fetch(`${router.endpoint}/rest/ip/hotspot/user`, { signal: AbortSignal.timeout(4000) });
        if (res.ok) {
          const users = (await res.json()) as any[];
          routerStats = {
            total: users.length,
            active: users.filter((u) => !u.expired).length,
            expired: users.filter((u) => u.expired).length,
          };
        }
      } catch (err) {
        // Router may be unreachable
      }
    }

    const webhookCount = await this.prisma.webhookEvent.count();
    const activeSessionsCount = await this.prisma.session.count({ where: { status: 'ACTIVE' } });

    return {
      payments: {
        total: allPayments.length,
        success: success.length,
        pending: pending.length,
      },
      revenue: {
        totalNGN: totalRevenueNGN,
        totalKobo: totalRevenueKobo,
        arpuNGN,
      },
      byPlan,
      router: routerStats,
      sessions: {
        active: activeSessionsCount,
      },
      webhookEvents: webhookCount,
    };
  }

  async getWebhookLogs(limit = 50) {
    const logs = await this.prisma.webhookEvent.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return logs.map((l) => ({
      ...l,
      eventId: l.eventKey,
      eventType: l.eventKey.split(':')[0] || 'webhook',
      payload: JSON.stringify(l.payloadJson).slice(0, 2000),
      createdAt: l.createdAt.getTime(),
    }));
  }

  async reconcile(venueId?: string) {
    const venue = venueId ? await this.venuesService.getVenueById(venueId) : await this.venuesService.getDefaultVenue();
    const cashoutSweep = this.cashouts
      ? await this.cashouts.reconcileProcessing(venue.id).catch((err: any) => ({ error: err.message }))
      : { skipped: true, reason: 'cashouts service unavailable' };
    const router = venue.routers[0];

    if (!router) {
      return {
        routerReachable: false,
        error: 'No router registered for venue',
        mismatches: [],
        healed: [],
        orphans: [],
        cashouts: cashoutSweep,
      };
    }

    let routerUsers: any[] = [];
    let routerReachable = true;

    try {
      const res = await fetch(`${router.endpoint}/rest/ip/hotspot/user`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) throw new Error(`router HTTP ${res.status}`);
      routerUsers = (await res.json()) as any[];
    } catch (err: any) {
      routerReachable = false;
      return {
        routerReachable: false,
        error: `Router unreachable: ${err.message}`,
        mismatches: [],
        healed: [],
        orphans: [],
        cashouts: cashoutSweep,
      };
    }

    const fulfilledPayments = await this.prisma.payment.findMany({
      where: {
        status: 'FULFILLED',
        order: { venueId: venue.id },
      },
      include: { order: { include: { plan: true } } },
    });

    const mismatches: any[] = [];
    const healed: any[] = [];

    for (const p of fulfilledPayments) {
      const mac = p.order.customerRef ? p.order.customerRef.toLowerCase() : null;
      if (!mac) continue;

      const activeOnRouter = routerUsers.find((u) => String(u.name).toLowerCase() === mac && !u.expired);
      if (!activeOnRouter) {
        mismatches.push({
          mac: p.order.customerRef,
          planId: p.order.planId,
          reference: p.providerReference,
          status: 'missing_on_router',
        });

        // Self-heal: enqueue re-provisioning
        await this.provisioningQueue.enqueue({ orderId: p.orderId });
        healed.push({
          mac: p.order.customerRef,
          orderId: p.orderId,
          plan: p.order.plan.name,
        });
      }
    }

    // Identify orphan users on router without matching payment
    const paymentMacs = new Set(
      fulfilledPayments.map((p) => (p.order.customerRef ? p.order.customerRef.toLowerCase() : '')),
    );
    const orphans = routerUsers
      .filter((u) => !paymentMacs.has(String(u.name).toLowerCase()))
      .map((u) => ({ mac: u.name, profile: u.profile }));

    return {
      routerReachable,
      totalPaymentsSuccess: fulfilledPayments.length,
      totalRouterUsers: routerUsers.length,
      mismatches,
      healed,
      orphans,
      cashouts: cashoutSweep,
      message:
        mismatches.length === 0
          ? 'Reconciliation OK — all fulfilled payments have active router sessions'
          : `Found ${mismatches.length} mismatch(es), ${healed.length} self-healed via provisioning queue`,
    };
  }

  async cleanup(venueId?: string) {
    const venue = venueId ? await this.venuesService.getVenueById(venueId) : await this.venuesService.getDefaultVenue();
    const router = venue.routers[0];
    if (!router) return { ok: false, error: 'No router registered' };

    try {
      const res = await fetch(`${router.endpoint}/rest/ip/hotspot/user`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) throw new Error(`router HTTP ${res.status}`);
      const users = (await res.json()) as any[];
      const expired = users.filter((u) => u.expired || u.remainingMs <= 0);

      let removed = 0;
      for (const u of expired) {
        const id = u['.id'] || u.name;
        const delRes = await fetch(`${router.endpoint}/rest/ip/hotspot/user/${encodeURIComponent(id)}`, {
          method: 'DELETE',
        }).catch(() => null);
        if (delRes && delRes.ok) removed++;
      }

      // Sync DB sessions
      await this.prisma.session.updateMany({
        where: {
          routerId: router.id,
          status: 'ACTIVE',
          expiresAt: { lt: new Date() },
        },
        data: { status: 'EXPIRED', endedAt: new Date() },
      });

      return { ok: true, foundExpired: expired.length, removed };
    } catch (err: any) {
      return { ok: false, error: `Cleanup failed: ${err.message}` };
    }
  }

  async verifyReference(reference: string) {
    const local = await this.prisma.payment.findUnique({
      where: { providerReference: reference },
      include: { order: { include: { plan: true } } },
    });

    if (this.paystack.isMock()) {
      return {
        verified: local?.status === 'FULFILLED',
        mode: 'mock',
        local,
        message: 'Mock mode active — verified against local database',
      };
    }

    try {
      const verifyRes = await this.paystack.verifyTransaction(reference);
      const isSuccess = verifyRes.data.status === 'success';
      if (isSuccess && local && local.status !== 'FULFILLED') {
        const { createHash, randomInt } = await import('crypto');
        const order = local.order as any;
        const isMac = order.customerRef && /^([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2})$/.test(order.customerRef);
        const expiresAt = new Date(Date.now() + (order.plan?.durationSeconds || 3600) * 1000);
        for (let attempt = 0; attempt < 5; attempt++) {
          const voucherCode = String(randomInt(100000, 1000000));
          try {
            await this.prisma.$transaction([
              this.prisma.payment.update({
                where: { id: local.id },
                data: { status: 'FULFILLED', paidAt: new Date(), providerTransactionId: String(verifyRes.data.id) },
              }),
              this.prisma.voucher.create({
                data: {
                  venueId: order.venueId,
                  planId: order.planId,
                  paymentId: local.id,
                  codeHash: createHash('sha256').update(voucherCode).digest('hex'),
                  displayCodeEnc: voucherCode,
                  status: 'ACTIVE',
                  issuedAt: new Date(),
                  redeemedAt: new Date(),
                  expiresAt,
                  redeemedMac: isMac ? order.customerRef.toUpperCase() : null,
                  redeemedDeviceId: isMac ? order.customerRef.toUpperCase() : null,
                  createdBy: 'admin_verify',
                },
              }),
              this.prisma.order.update({
                where: { id: local.orderId },
                data: { status: 'PROVISIONING' },
              }),
            ]);
            break;
          } catch (err: any) {
            if (err.code === 'P2002') continue;
            throw err;
          }
        }
        try {
          const db = this.prisma as any;
          if (db.notification) {
            await db.notification.create({
              data: {
                venueId: order.venueId,
                type: 'PAYMENT',
                title: `Payment verified — ${(order.amountMinor / 100).toLocaleString('en-NG', { style: 'currency', currency: 'NGN' })}`,
                body: `Reference ${reference} verified. Voucher is active.`,
                amountMinor: order.amountMinor,
                reference,
              },
            });
          }
        } catch {}
        try {
          await this.provisioningQueue.enqueue({ orderId: local.orderId });
        } catch (err: any) {
          this.logger.warn(`Provisioning enqueue failed after admin verify: ${err.message}`);
        }
      }
      return {
        verified: isSuccess,
        paystack: verifyRes.data,
        local,
      };
    } catch (err: any) {
      return { verified: false, error: err.message, local };
    }
  }

  async getUserProfile(email?: string) {
    const targetEmail = (email || 'talk2icedmist@gmail.com').toLowerCase().trim();
    return this.prisma.user.findUnique({ where: { email: targetEmail } });
  }

  async updateUserProfile(email?: string, name?: string, newEmail?: string) {
    const targetEmail = (email || 'talk2icedmist@gmail.com').toLowerCase().trim();
    const user = await this.prisma.user.findUnique({ where: { email: targetEmail } });
    if (user) {
      return this.prisma.user.update({
        where: { id: user.id },
        data: {
          name: name !== undefined ? name : user.name,
          email: newEmail ? newEmail.toLowerCase().trim() : user.email,
        },
      });
    }
    return this.prisma.user.create({
      data: {
        email: (newEmail || targetEmail).toLowerCase().trim(),
        name: name || 'Venue Owner',
        status: 'active',
      },
    });
  }

  async deleteUserAccount(email?: string, supabaseUserId?: string) {
    const targetEmail = (email || 'talk2icedmist@gmail.com').toLowerCase().trim();
    const user = await this.prisma.user.findUnique({ where: { email: targetEmail } });

    // 1. Delete user from Supabase Auth admin API if service key exists
    const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
    const uidToDelete = supabaseUserId || user?.id;

    if (supabaseUrl && serviceKey && uidToDelete) {
      try {
        await fetch(`${supabaseUrl.replace(/\/$/, '')}/auth/v1/admin/users/${uidToDelete}`, {
          method: 'DELETE',
          headers: {
            Authorization: `Bearer ${serviceKey}`,
            apikey: serviceKey,
          },
        });
      } catch (_) {}
    }

    // 2. Clean up Prisma database records
    if (user) {
      await this.prisma.venueMember.deleteMany({ where: { userId: user.id } });
      await this.prisma.user.update({
        where: { id: user.id },
        data: { status: 'deleted' },
      });
      return { id: user.id, email: targetEmail, status: 'deleted' };
    }
    return { email: targetEmail, status: 'deleted' };
  }

  // ── Fleet & System Health ────────────────────────────────────────────────

  async getFleetOverview() {
    try {
      const venues = await this.prisma.venue.findMany({
        include: {
          routers: true,
          _count: {
            select: {
              sessions: { where: { status: 'ACTIVE' } },
              vouchers: true,
              plans: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
      });

      const totalRouters = venues.reduce((acc, v) => acc + v.routers.length, 0);
      const onlineRouters = venues.reduce(
        (acc, v) => acc + v.routers.filter((r) => r.status === 'ONLINE').length,
        0,
      );
      const totalActiveSessions = venues.reduce((acc, v) => acc + v._count.sessions, 0);
      const totalVouchers = venues.reduce((acc, v) => acc + v._count.vouchers, 0);

      return {
        ok: true,
        summary: {
          totalVenues: venues.length,
          totalRouters,
          onlineRouters,
          offlineRouters: totalRouters - onlineRouters,
          totalActiveSessions,
          totalVouchers,
        },
        venues: venues.map((v) => ({
          id: v.id,
          name: v.name,
          slug: v.slug,
          status: v.status,
          currency: v.currency,
          createdAt: v.createdAt,
          routers: v.routers.map((r) => ({
            id: r.id,
            name: r.name,
            endpoint: r.endpoint,
            status: r.status,
            connectionMode: r.connectionMode,
            rosVersion: r.rosVersion,
            lastSeen: r.lastSeen,
          })),
          activeSessions: v._count.sessions,
          vouchersCount: v._count.vouchers,
          plansCount: v._count.plans,
        })),
      };
    } catch (err: any) {
      return { ok: false, error: `Failed to fetch fleet overview: ${err.message}` };
    }
  }

  async getSystemHealth() {
    let dbStatus = 'ok';
    let dbLatencyMs = 0;
    try {
      const start = Date.now();
      await this.prisma.$queryRawUnsafe('SELECT 1');
      dbLatencyMs = Date.now() - start;
    } catch (err: any) {
      dbStatus = `error: ${err.message}`;
    }

    const memoryUsage = process.memoryUsage();

    return {
      ok: true,
      status: dbStatus === 'ok' ? 'HEALTHY' : 'DEGRADED',
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.floor(process.uptime()),
      database: {
        status: dbStatus,
        latencyMs: dbLatencyMs,
      },
      memory: {
        rssMB: Math.round(memoryUsage.rss / 1024 / 1024),
        heapUsedMB: Math.round(memoryUsage.heapUsed / 1024 / 1024),
        heapTotalMB: Math.round(memoryUsage.heapTotal / 1024 / 1024),
      },
      environment: process.env.NODE_ENV || 'production',
      nodeVersion: process.version,
    };
  }

  // ── Audits Engine ────────────────────────────────────────────────────────

  private auditLogs: Array<{
    id: string;
    action: string;
    category: string;
    actor: string;
    details?: any;
    status: string;
    timestamp: string;
  }> = [
    {
      id: 'init-1',
      action: 'SYSTEM_BOOT',
      category: 'SYSTEM',
      actor: 'system',
      details: { platform: 'WavePass Cloud Engine' },
      status: 'SUCCESS',
      timestamp: new Date().toISOString(),
    },
  ];

  async getAuditLogs(category?: string, limit = 100) {
    let logs = [...this.auditLogs];
    if (category && category.trim().length > 0) {
      logs = logs.filter((l) => l.category.toLowerCase() === category.toLowerCase());
    }
    return {
      ok: true,
      count: logs.length,
      logs: logs.slice(0, limit),
    };
  }

  async logAudit(entry: {
    action: string;
    category?: string;
    actor?: string;
    details?: any;
    status?: string;
  }) {
    const record = {
      id: `audit_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      action: entry.action,
      category: entry.category || 'GENERAL',
      actor: entry.actor || 'system',
      details: entry.details,
      status: entry.status || 'SUCCESS',
      timestamp: new Date().toISOString(),
    };
    this.auditLogs.unshift(record);
    if (this.auditLogs.length > 2000) {
      this.auditLogs.pop();
    }
    return { ok: true, record };
  }

  // ── Activation Code Engine (persistent, per-code expiry) ──────────────────
  // Codes are issued by the system admin to specific venues, each carrying its
  // own expiry date (monthly rotation). Expired codes deny activation so apps
  // can pause all activity until a fresh code is redeemed.

  private toActivationView(row: any) {
    return {
      code: row.code,
      status: row.status,
      kind: row.kind || 'LICENSE',
      createdBy: row.createdBy,
      createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
      authorizedAt: row.authorizedAt instanceof Date ? row.authorizedAt.toISOString() : row.authorizedAt,
      redeemedBy: row.redeemedBy,
      venueId: row.venueId,
      usedAt: row.usedAt instanceof Date ? row.usedAt.toISOString() : row.usedAt,
      quota: row.quota,
      usedCount: row.usedCount,
      expiresAt: row.expiresAt instanceof Date ? row.expiresAt.toISOString() : row.expiresAt,
      notes: row.notes,
    };
  }

  private isExpired(row: any): boolean {
    if (row.status === 'EXPIRED') return true;
    if (row.expiresAt && new Date(row.expiresAt).getTime() < Date.now()) return true;
    return false;
  }

  /** Lazily flip past-due codes to EXPIRED (no cron required). */
  private async sweepExpiredCodes() {
    try {
      await this.prisma.activationCode.updateMany({
        where: { expiresAt: { lt: new Date() }, status: { in: ['PENDING', 'AUTHORIZED', 'USED'] } },
        data: { status: 'EXPIRED' },
      });
    } catch {}
  }

  async listActivationCodes() {
    await this.sweepExpiredCodes();
    const rows = await this.prisma.activationCode.findMany({ orderBy: { createdAt: 'desc' } });
    return { ok: true, count: rows.length, codes: rows.map((r) => this.toActivationView(r)) };
  }

  private randomCodePart(): string {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let part = '';
    for (let j = 0; j < 4; j++) part += chars[Math.floor(Math.random() * chars.length)];
    return part;
  }

  /**
   * Monthly issuance: pass `venueIds` to mint one code per venue (each with the
   * same kind/expiry), or `count` for unassigned codes.
   *
   * Kinds: LICENSE (venue-bound, single-use) | MASTER (multi-use up to quota,
   * not venue-bound) | TRIAL (short-lived single-use).
   * Duration: `durationDays` computes expiresAt from now (null = lifetime,
   * allowed for MASTER; LICENSE defaults 30d, TRIAL defaults 7d).
   * Explicit `expiresAt` overrides `durationDays`.
   */
  async generateActivationCodes(
    count = 1,
    note?: string,
    quota = 1,
    createdBy = 'talk2icedmist@gmail.com',
    expiresAt?: string | Date,
    venueIds?: string[],
    kind: 'LICENSE' | 'MASTER' | 'TRIAL' = 'LICENSE',
    durationDays?: number | null,
  ) {
    const k = (kind || 'LICENSE').toUpperCase() as 'LICENSE' | 'MASTER' | 'TRIAL';
    let expiry = expiresAt ? new Date(expiresAt) : null;
    if (!expiry && durationDays !== undefined && durationDays !== null) {
      expiry = durationDays > 0 ? new Date(Date.now() + durationDays * 86400000) : null;
    }
    if (!expiry && durationDays === undefined && !expiresAt) {
      const defaults: Record<string, number | null> = { LICENSE: 30, MASTER: null, TRIAL: 7 };
      const d = defaults[k];
      expiry = d ? new Date(Date.now() + d * 86400000) : null;
    }
    const targets = venueIds && venueIds.length > 0 ? venueIds : Array(Math.max(1, count)).fill(null);
    const generated: any[] = [];

    for (const venueId of targets) {
      const code = `WP-ACT-${this.randomCodePart()}-${this.randomCodePart()}`;
      const record = await this.prisma.activationCode.create({
        data: {
          code,
          status: 'AUTHORIZED',
          kind: k,
          createdBy,
          authorizedAt: new Date(),
          quota: k === 'MASTER' ? quota || 5 : 1,
          usedCount: 0,
          expiresAt: expiry,
          venueId: k === 'LICENSE' ? venueId || null : null,
          notes: note || (venueId ? `Monthly activation for venue ${venueId}` : 'Venue Activation Code'),
        },
      });
      generated.push(this.toActivationView(record));
    }

    await this.logAudit({
      action: 'ACTIVATION_CODES_GENERATED',
      category: 'ACTIVATION',
      actor: createdBy,
      details: { count: generated.length, codes: generated.map((g) => g.code), kind: k, expiresAt: expiry?.toISOString() },
    });

    return { ok: true, count: generated.length, codes: generated };
  }

  async authorizeActivationCode(code: string, status: 'AUTHORIZED' | 'REVOKED') {
    const clean = code.toUpperCase().trim();
    const item = await this.prisma.activationCode.findUnique({ where: { code: clean } });
    if (!item) {
      return { ok: false, error: 'Activation code not found' };
    }
    const updated = await this.prisma.activationCode.update({
      where: { code: clean },
      data: { status, authorizedAt: status === 'AUTHORIZED' ? new Date() : item.authorizedAt },
    });
    await this.logAudit({
      action: status === 'AUTHORIZED' ? 'ACTIVATION_CODE_AUTHORIZED' : 'ACTIVATION_CODE_REVOKED',
      category: 'ACTIVATION',
      actor: 'system_admin',
      details: { code: clean },
    });
    return { ok: true, code: this.toActivationView(updated) };
  }

  async checkAccountActivation(email: string) {
    const cleanEmail = email.toLowerCase().trim();
    // System admin is permanently activated
    if (cleanEmail === 'talk2icedmist@gmail.com') {
      return { ok: true, activated: true, role: 'system_admin', code: 'SUPER-ADMIN' };
    }

    await this.sweepExpiredCodes();
    // Redemption ledger is the source of truth: every redeemer keeps their own
    // grant even after a multi-use MASTER code is fully consumed by others.
    const redemption = await this.prisma.activationRedemption.findFirst({
      where: { email: cleanEmail },
      include: { code: true },
      orderBy: { redeemedAt: 'desc' },
    });
    const row = (redemption?.code as any) || await this.prisma.activationCode.findFirst({
      where: { status: 'USED', redeemedBy: cleanEmail },
      orderBy: { usedAt: 'desc' },
    });
    if (!row) {
      return { ok: true, activated: false };
    }
    if (row.status === 'REVOKED' || this.isExpired(row)) {
      return {
        ok: true,
        activated: false,
        expired: this.isExpired(row),
        code: row.code,
        kind: row.kind || 'LICENSE',
        venueId: row.venueId,
        usedAt: row.usedAt,
        expiresAt: row.expiresAt,
      };
    }

    return {
      ok: true,
      activated: true,
      code: row.code,
      kind: row.kind || 'LICENSE',
      venueId: row.venueId,
      usedAt: row.usedAt,
      expiresAt: row.expiresAt,
    };
  }

  async redeemActivationCode(code: string, email: string, venueId?: string) {
    const cleanCode = code.toUpperCase().trim();
    const cleanEmail = email.toLowerCase().trim();

    const item = await this.prisma.activationCode.findUnique({ where: { code: cleanCode } });
    if (!item) {
      await this.logAudit({
        action: 'ACTIVATION_CODE_REDEEM_FAILED',
        category: 'ACTIVATION',
        actor: cleanEmail,
        details: { code: cleanCode, reason: 'NOT_FOUND' },
        status: 'FAILURE',
      });
      return { ok: false, error: 'Invalid activation code' };
    }

    if (this.isExpired(item)) {
      if (item.status !== 'EXPIRED') {
        await this.prisma.activationCode.update({ where: { code: cleanCode }, data: { status: 'EXPIRED' } });
      }
      return { ok: false, error: 'This activation code has expired. Please request a new monthly code from the system admin.', expired: true };
    }

    if (item.status === 'USED' || item.usedCount >= item.quota) {
      return { ok: false, error: 'Activation code has already been redeemed' };
    }

    if (item.status === 'REVOKED' || item.status === 'PENDING') {
      return { ok: false, error: 'Activation code is not authorized. Please contact system admin.' };
    }

    // Venue-bound LICENSE codes only activate their assigned venue.
    // MASTER/TRIAL codes are not venue-bound.
    if ((item as any).kind === 'LICENSE' && item.venueId && venueId && item.venueId !== venueId) {
      await this.logAudit({
        action: 'ACTIVATION_CODE_REDEEM_FAILED',
        category: 'ACTIVATION',
        actor: cleanEmail,
        details: { code: cleanCode, reason: 'VENUE_MISMATCH', expected: item.venueId, got: venueId },
        status: 'FAILURE',
      });
      return { ok: false, error: 'This activation code was issued for a different venue.' };
    }

    // MASTER codes are multi-use: consume one quota unit, stay AUTHORIZED
    // until the quota is exhausted. Each redeemer gets their own ledger row
    // so earlier redeemers keep activation after later ones consume quota.
    const isMaster = (item as any).kind === 'MASTER';
    const nextUsed = (item.usedCount || 0) + 1;
    try {
      await this.prisma.activationRedemption.create({
        data: { codeId: item.id, email: cleanEmail, venueId: venueId || item.venueId },
      });
    } catch (err: any) {
      if (err.code === 'P2002') {
        return { ok: false, error: 'This account has already redeemed this code' };
      }
      throw err;
    }
    const updated = await this.prisma.activationCode.update({
      where: { code: cleanCode },
      data: {
        status: !isMaster || nextUsed >= item.quota ? 'USED' : 'AUTHORIZED',
        redeemedBy: cleanEmail,
        venueId: venueId || item.venueId,
        usedAt: new Date(),
        usedCount: { increment: 1 },
      },
    });

    await this.logAudit({
      action: 'ACTIVATION_CODE_REDEEMED',
      category: 'ACTIVATION',
      actor: cleanEmail,
      details: { code: cleanCode, venueId: updated.venueId },
      status: 'SUCCESS',
    });

    return {
      ok: true,
      message: 'Venue activated successfully! You can now set up your router.',
      code: this.toActivationView(updated),
    };
  }

  // ── Activation Code Requests ─────────────────────────────────────────────
  // Users without a code request one from the app. The system admin sees
  // their details and either grants a real code or direct time-boxed access.

  async createActivationRequest(body: {
    email: string; name?: string; phone?: string; venueName?: string; venueId?: string; message?: string;
  }) {
    const email = (body.email || '').toLowerCase().trim();
    if (!email || !email.includes('@')) {
      return { ok: false, error: 'A valid email address is required' };
    }
    const dupe = await this.prisma.activationRequest.findFirst({
      where: { email, status: 'PENDING', venueId: body.venueId || undefined },
    });
    if (dupe) {
      return { ok: true, request: dupe, duplicate: true, message: 'You already have a pending request — the admin will review it.' };
    }
    const request = await this.prisma.activationRequest.create({
      data: {
        email,
        name: body.name?.trim() || null,
        phone: body.phone?.trim() || null,
        venueName: body.venueName?.trim() || null,
        venueId: body.venueId?.trim() || null,
        message: body.message?.trim() || null,
      },
    });
    await this.logAudit({
      action: 'ACTIVATION_REQUEST_CREATED',
      category: 'ACTIVATION',
      actor: email,
      details: { requestId: request.id, venueName: request.venueName },
    });
    return { ok: true, request, message: 'Request sent — the system admin will review it shortly.' };
  }

  async listActivationRequests(status?: string) {
    const rows = await this.prisma.activationRequest.findMany({
      where: status ? { status: status as any } : {},
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return { ok: true, count: rows.length, requests: rows };
  }

  /**
   * Approve a request two ways:
   *  - code: mint a real LICENSE code bound to the requester's venue.
   *  - direct: grant time-boxed access immediately (pre-redeemed grant row).
   */
  async approveActivationRequest(
    id: string,
    opts: { reviewedBy?: string; mode?: 'code' | 'direct'; kind?: 'LICENSE' | 'MASTER' | 'TRIAL'; durationDays?: number | null; expiresAt?: string; reviewNote?: string },
  ) {
    const request = await this.prisma.activationRequest.findUnique({ where: { id } });
    if (!request) return { ok: false, error: 'Request not found' };
    if (request.status === 'GRANTED') return { ok: false, error: 'Request already granted' };
    if (request.status === 'REJECTED') return { ok: false, error: 'Request was rejected — ask the owner to submit a new one' };

    const reviewer = opts.reviewedBy || 'talk2icedmist@gmail.com';
    const mode = opts.mode || 'code';

    if (mode === 'direct') {
      const until = opts.expiresAt ? new Date(opts.expiresAt)
        : new Date(Date.now() + (opts.durationDays ?? 30) * 86400000);
      const grant = await this.prisma.activationCode.create({
        data: {
          code: `DIRECT-${Math.random().toString(36).slice(2, 10).toUpperCase()}`,
          status: 'USED',
          kind: 'LICENSE',
          createdBy: reviewer,
          authorizedAt: new Date(),
          redeemedBy: request.email,
          venueId: request.venueId,
          usedAt: new Date(),
          quota: 1,
          usedCount: 1,
          expiresAt: until,
          notes: `Direct admin grant for request ${request.id}${opts.reviewNote ? ` — ${opts.reviewNote}` : ''}`,
        },
      });
      await this.prisma.activationRedemption.create({
        data: { codeId: grant.id, email: request.email, venueId: request.venueId },
      });
      const updated = await this.prisma.activationRequest.update({
        where: { id },
        data: { status: 'GRANTED', grantedCodeId: grant.id, grantedUntil: until, reviewedBy: reviewer, reviewedAt: new Date(), reviewNote: opts.reviewNote },
      });
      await this.logAudit({ action: 'ACTIVATION_REQUEST_GRANTED_DIRECT', category: 'ACTIVATION', actor: reviewer, details: { requestId: id, email: request.email, until } });
      return { ok: true, request: updated, mode: 'direct', grantedUntil: until, message: `Direct access granted until ${until.toISOString()}` };
    }

    const gen = await this.generateActivationCodes(
      1,
      `Granted for ${request.venueName || request.email} (request ${request.id})`,
      1,
      reviewer,
      opts.expiresAt,
      request.venueId ? [request.venueId] : undefined,
      opts.kind || 'LICENSE',
      opts.durationDays,
    );
    const updated = await this.prisma.activationRequest.update({
      where: { id },
      data: {
        status: 'GRANTED',
        grantedCodeId: gen.codes[0]?.code,
        reviewedBy: reviewer,
        reviewedAt: new Date(),
        reviewNote: opts.reviewNote,
      },
    });
    await this.logAudit({ action: 'ACTIVATION_REQUEST_GRANTED_CODE', category: 'ACTIVATION', actor: reviewer, details: { requestId: id, email: request.email, code: gen.codes[0]?.code } });
    return { ok: true, request: updated, mode: 'code', code: gen.codes[0]?.code, expiresAt: gen.codes[0]?.expiresAt, message: 'Code granted — share it with the venue owner.' };
  }

  async rejectActivationRequest(id: string, opts: { reviewedBy?: string; reviewNote?: string }) {
    const request = await this.prisma.activationRequest.findUnique({ where: { id } });
    if (!request) return { ok: false, error: 'Request not found' };
    const updated = await this.prisma.activationRequest.update({
      where: { id },
      data: { status: 'REJECTED', reviewedBy: opts.reviewedBy || 'talk2icedmist@gmail.com', reviewedAt: new Date(), reviewNote: opts.reviewNote },
    });
    await this.logAudit({ action: 'ACTIVATION_REQUEST_REJECTED', category: 'ACTIVATION', actor: opts.reviewedBy || 'system_admin', details: { requestId: id } });
    return { ok: true, request: updated };
  }
}
