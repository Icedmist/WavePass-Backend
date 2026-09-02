import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';
import { PaystackService } from '../paystack/paystack.service';
import { MikrotikProvisioningQueue } from '../mikrotik/mikrotik-provisioning.queue';
import { VenuesService } from '../venues/venues.service';

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly paystack: PaystackService,
    private readonly venuesService: VenuesService,
    private readonly provisioningQueue: MikrotikProvisioningQueue,
  ) {}

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
}
