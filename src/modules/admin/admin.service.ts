import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';
import { PaystackService } from '../paystack/paystack.service';
import { MikrotikProvisioningQueue } from '../mikrotik/mikrotik-provisioning.queue';
import { VenuesService } from '../venues/venues.service';

@Injectable()
export class AdminService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AdminService.name);
  private cleanupTimer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly paystack: PaystackService,
    private readonly venuesService: VenuesService,
    private readonly provisioningQueue: MikrotikProvisioningQueue,
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
    const router = venue.routers[0];

    if (!router) {
      return {
        routerReachable: false,
        error: 'No router registered for venue',
        mismatches: [],
        healed: [],
        orphans: [],
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

    const secret = process.env.PAYSTACK_SECRET_KEY || '';
    if (!secret || secret.includes('xxx')) {
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
        await this.prisma.payment.update({
          where: { id: local.id },
          data: { status: 'FULFILLED', paidAt: new Date() },
        });
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

  async deleteUserAccount(email?: string) {
    const targetEmail = (email || 'talk2icedmist@gmail.com').toLowerCase().trim();
    const user = await this.prisma.user.findUnique({ where: { email: targetEmail } });
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

  // ── Activation Code Engine ───────────────────────────────────────────────

  private activationCodes: Array<{
    code: string;
    status: 'AUTHORIZED' | 'PENDING' | 'USED' | 'REVOKED';
    createdBy: string;
    createdAt: string;
    authorizedAt?: string;
    redeemedBy?: string;
    venueId?: string;
    usedAt?: string;
    quota: number;
    notes?: string;
  }> = [
    {
      code: 'WP-ACT-NEXA-2025',
      status: 'AUTHORIZED',
      createdBy: 'talk2icedmist@gmail.com',
      createdAt: new Date().toISOString(),
      authorizedAt: new Date().toISOString(),
      quota: 1,
      notes: 'Master activation code for initial system rollout',
    },
    {
      code: 'WP-ACT-VIP-8899',
      status: 'AUTHORIZED',
      createdBy: 'talk2icedmist@gmail.com',
      createdAt: new Date().toISOString(),
      authorizedAt: new Date().toISOString(),
      quota: 1,
      notes: 'Production rollout voucher activation',
    },
  ];

  async listActivationCodes() {
    return {
      ok: true,
      count: this.activationCodes.length,
      codes: this.activationCodes,
    };
  }

  async generateActivationCodes(count = 1, note?: string, quota = 1, createdBy = 'talk2icedmist@gmail.com') {
    const generated: any[] = [];
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

    for (let i = 0; i < count; i++) {
      let part1 = '';
      let part2 = '';
      for (let j = 0; j < 4; j++) {
        part1 += chars[Math.floor(Math.random() * chars.length)];
        part2 += chars[Math.floor(Math.random() * chars.length)];
      }
      const code = `WP-ACT-${part1}-${part2}`;
      const record = {
        code,
        status: 'AUTHORIZED' as const,
        createdBy,
        createdAt: new Date().toISOString(),
        authorizedAt: new Date().toISOString(),
        quota: quota || 1,
        notes: note || 'Venue Activation Code',
      };
      this.activationCodes.unshift(record);
      generated.push(record);
    }

    await this.logAudit({
      action: 'ACTIVATION_CODES_GENERATED',
      category: 'ACTIVATION',
      actor: createdBy,
      details: { count, codes: generated.map((g) => g.code) },
    });

    return { ok: true, count: generated.length, codes: generated };
  }

  async authorizeActivationCode(code: string, status: 'AUTHORIZED' | 'REVOKED') {
    const item = this.activationCodes.find((c) => c.code.toUpperCase() === code.toUpperCase());
    if (!item) {
      return { ok: false, error: 'Activation code not found' };
    }
    item.status = status;
    if (status === 'AUTHORIZED') {
      item.authorizedAt = new Date().toISOString();
    }
    await this.logAudit({
      action: status === 'AUTHORIZED' ? 'ACTIVATION_CODE_AUTHORIZED' : 'ACTIVATION_CODE_REVOKED',
      category: 'ACTIVATION',
      actor: 'system_admin',
      details: { code },
    });
    return { ok: true, code: item };
  }

  async checkAccountActivation(email: string) {
    const cleanEmail = email.toLowerCase().trim();
    // System admin is permanently activated
    if (cleanEmail === 'talk2icedmist@gmail.com') {
      return { ok: true, activated: true, role: 'system_admin', code: 'SUPER-ADMIN' };
    }

    const match = this.activationCodes.find(
      (c) => c.status === 'USED' && c.redeemedBy?.toLowerCase() === cleanEmail,
    );

    return {
      ok: true,
      activated: !!match,
      code: match?.code,
      venueId: match?.venueId,
      usedAt: match?.usedAt,
    };
  }

  async redeemActivationCode(code: string, email: string, venueId?: string) {
    const cleanCode = code.toUpperCase().trim();
    const cleanEmail = email.toLowerCase().trim();

    const item = this.activationCodes.find((c) => c.code.toUpperCase() === cleanCode);
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

    if (item.status === 'USED') {
      return { ok: false, error: 'Activation code has already been redeemed' };
    }

    if (item.status === 'REVOKED' || item.status === 'PENDING') {
      return { ok: false, error: 'Activation code is not authorized. Please contact system admin.' };
    }

    item.status = 'USED';
    item.redeemedBy = cleanEmail;
    item.venueId = venueId;
    item.usedAt = new Date().toISOString();

    await this.logAudit({
      action: 'ACTIVATION_CODE_REDEEMED',
      category: 'ACTIVATION',
      actor: cleanEmail,
      details: { code: cleanCode, venueId },
      status: 'SUCCESS',
    });

    return {
      ok: true,
      message: 'Venue activated successfully! You can now set up your router.',
      code: item,
    };
  }
}
