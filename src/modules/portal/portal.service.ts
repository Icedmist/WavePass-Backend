import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';
import { PaystackService } from '../paystack/paystack.service';
import { MikrotikProvisioningQueue } from '../mikrotik/mikrotik-provisioning.queue';
import { InitPaymentDto } from './dto/init-payment.dto';
import { PlansService } from '../plans/plans.service';
import { VenuesService } from '../venues/venues.service';

@Injectable()
export class PortalService {
  private readonly logger = new Logger(PortalService.name);
  private readonly frontendUrl = process.env.FRONTEND_URL || 'https://nexawavepass.com';
  private readonly paystackSecret = process.env.PAYSTACK_SECRET_KEY || '';

  constructor(
    private readonly prisma: PrismaService,
    private readonly paystack: PaystackService,
    private readonly plansService: PlansService,
    private readonly venuesService: VenuesService,
    private readonly provisioningQueue: MikrotikProvisioningQueue,
  ) {}

  async getPortalPlans(venueId?: string) {
    if (!venueId) {
      const defaultVenue = await this.venuesService.getDefaultVenue();
      venueId = defaultVenue.id;
    }
    return this.plansService.listPlans(venueId);
  }

  async initPayment(dto: InitPaymentDto) {
    const mac = dto.mac.toUpperCase();

    // 1. Fetch and validate plan (amount locked server-side — PRD §4.4, §13)
    let plan: any;
    try {
      plan = await this.plansService.getPlanById(dto.planId);
    } catch {
      throw new NotFoundException(`Plan ${dto.planId} not found`);
    }

    const venueId = dto.venueId || plan.venueId;
    const amount = plan.priceMinor;
    const reference = `wp_hs_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const customerEmail = dto.email && dto.email.includes('@') && !dto.email.endsWith('.local')
      ? dto.email
      : `guest_${mac.replace(/[:-]/g, '').toLowerCase()}@nexawavepass.com`;

    // 2. Create Order in database
    const order = await this.prisma.order.create({
      data: {
        venueId,
        planId: plan.id,
        customerRef: mac,
        amountMinor: amount,
        status: 'AWAITING_PAYMENT',
      },
    });

    // 3. Create Payment record in PENDING state
    await this.prisma.payment.create({
      data: {
        orderId: order.id,
        providerReference: reference,
        amountMinor: amount,
        status: 'PENDING',
      },
    });

    // 4. If offline/mock mode (no Paystack key or dummy xxxxx)
    const isMock = !this.paystackSecret || this.paystackSecret.includes('xxx');
    if (isMock) {
      const mockUrl = `${this.frontendUrl}/success?reference=${reference}&mac=${encodeURIComponent(mac)}&plan=${plan.id}&mock=1`;
      return {
        authorization_url: mockUrl,
        reference,
        amount,
        plan,
        mock: true,
        message: 'Mock mode active. Visit authorization_url to simulate payment.',
      };
    }

    // 5. Real Paystack initialize
    const init = await this.paystack.initializeTransaction({
      email: customerEmail,
      amountMinor: amount,
      reference,
      callbackUrl: `${this.frontendUrl}/success?reference=${reference}`,
      metadata: {
        orderId: order.id,
        venueId,
        planId: plan.id,
        mac_address: mac,
        profile: plan.profile,
      },
    });

    return {
      authorization_url: (init as any).data.authorization_url,
      reference,
      amount,
      plan,
    };
  }

  async simulatePayment(body: { mac: string; planId: string; venueId?: string }) {
    if (!body.mac || !body.planId) {
      throw new BadRequestException('mac and planId required');
    }

    const initResult = await this.initPayment({
      mac: body.mac,
      planId: body.planId,
      venueId: body.venueId,
    });

    const payment = await this.prisma.payment.findUniqueOrThrow({
      where: { providerReference: initResult.reference },
      include: { order: true },
    });

    // Atomically fulfill payment
    await this.prisma.$transaction([
      this.prisma.payment.update({
        where: { id: payment.id },
        data: { status: 'FULFILLED', paidAt: new Date() },
      }),
      this.prisma.order.update({
        where: { id: payment.orderId },
        data: { status: 'PROVISIONING' },
      }),
    ]);

    // Enqueue provisioning
    await this.provisioningQueue.enqueue({ orderId: payment.orderId });

    return {
      ok: true,
      reference: initResult.reference,
      mac: body.mac.toUpperCase(),
      planId: body.planId,
      status: 'provisioning_enqueued',
    };
  }

  private async resolveVenueBase(venueSlugOrId?: string, routerId?: string): Promise<string> {
    // Returns e.g. https://flagship.nexawavepass.com or falls back to FRONTEND_URL
    try {
      if (venueSlugOrId) {
        let venue: any = null;
        try {
          venue = await this.venuesService.getVenueBySlug(venueSlugOrId.toLowerCase().trim());
        } catch {
          try {
            venue = await this.venuesService.getVenueById(venueSlugOrId);
          } catch {}
        }
        if (venue?.slug) return `https://${venue.slug}.nexawavepass.com`;
      }
      if (routerId) {
        const router = await this.prisma.router.findUnique({ where: { id: routerId }, include: { venue: true } });
        if (router?.venue?.slug) return `https://${router.venue.slug}.nexawavepass.com`;
      }
    } catch {}
    return this.frontendUrl;
  }

  async getCaptiveRedirect(mac: string, ip?: string, linkOrig?: string, username?: string, venueSlugOrId?: string, routerId?: string): Promise<string> {
    const base = await this.resolveVenueBase(venueSlugOrId, routerId);
    const qs = new URLSearchParams();
    if (mac) qs.set('mac', mac.toUpperCase());
    if (ip) qs.set('ip', ip);
    if (linkOrig) qs.set('link-orig', linkOrig);
    if (username) qs.set('username', username);
    // If device already has paid session, send it to success instead of new checkout
    if (mac) {
      try {
        const s = await this.getLandingStatus(mac, ip);
        if (s.hasPaid) {
          qs.set('paid', '1');
          return `${base}/success?${qs.toString()}`;
        }
      } catch {}
    }
    return `${base}/portal?${qs.toString()}`;
  }

  async getLandingStatus(mac?: string, ip?: string) {
    const normalized = (mac || '').toUpperCase().trim();
    let session: any = null;
    if (normalized) {
      session = await this.prisma.session.findFirst({
        where: { mac: normalized, status: 'ACTIVE' },
        include: { router: { select: { id: true, name: true, endpoint: true } }, voucher: { include: { plan: true } } },
        orderBy: { startedAt: 'desc' },
      });
    }
    // Fallback: manual visit has no ?mac= (browser never exposes MAC) — match by last-seen IP
    if (!session && ip) {
      session = await this.prisma.session.findFirst({
        where: { ip, status: 'ACTIVE' },
        include: { router: { select: { id: true, name: true, endpoint: true } }, voucher: { include: { plan: true } } },
        orderBy: { startedAt: 'desc' },
      });
    }

    // Fallback 2: check if device has a redeemed active voucher even if session record was reset
    let activeVoucher: any = null;
    if (!session && normalized) {
      const redeemedVouchers = await this.prisma.voucher.findMany({
        where: { redeemedMac: normalized, status: 'REDEEMED' },
        include: { plan: true, venue: true },
        orderBy: { redeemedAt: 'desc' },
        take: 3,
      });

      const now = Date.now();
      for (const v of redeemedVouchers) {
        const durationMs = (v.plan?.durationSeconds || 3600) * 1000;
        const expiry = v.expiresAt ? v.expiresAt.getTime() : (v.redeemedAt ? v.redeemedAt.getTime() + durationMs : 0);
        if (expiry > now) {
          activeVoucher = { ...v, calculatedExpiry: new Date(expiry) };
          session = {
            id: `v_${v.id}`,
            mac: normalized,
            voucher: v,
            expiresAt: new Date(expiry),
            startedAt: v.redeemedAt || v.issuedAt,
          };
          break;
        }
      }
    }

    // Try to enrich with live router data (bytes, IP) if session exists
    // Try to enrich with live router data (bytes, IP, live session-time-left) if router exists
    let live: any = null;
    let dataUsedBytes = 0;
    let dataLimitBytes: number | null = null;
    let deviceIp = ip || session?.ip || null;
    let isConnectedOnRouter = false;
    let routerRemainingMs: number | null = null;

    let targetRouter = session?.router;
    if (!targetRouter && normalized) {
      targetRouter = await this.prisma.router.findFirst({
        where: { status: 'ONLINE' },
        orderBy: { lastSeen: 'desc' },
      });
    }

    if (targetRouter?.endpoint) {
      try {
        const { MikrotikAdapter } = await import('../mikrotik/mikrotik.adapter');
        const adapter = new MikrotikAdapter();
        const creds = {
          username: process.env.MIKROTIK_API_USER || 'admin',
          password: process.env.MIKROTIK_API_PASS || '',
        };
        const rows = await adapter.getActiveHotspotData(targetRouter.endpoint, creds);
        live = rows.find((r: any) =>
          String(r['mac-address'] || r.mac || '').toUpperCase() === normalized ||
          String(r.user || '').toUpperCase() === normalized
        );
        if (live) {
          isConnectedOnRouter = true;
          deviceIp = live.address || live.ip || deviceIp;
          dataUsedBytes = Number(live['bytes-in'] || 0) + Number(live['bytes-out'] || 0);
          if (live['session-time-left']) {
            const parsedSec = adapter.parseRouterOsDuration(live['session-time-left']);
            if (parsedSec > 0) routerRemainingMs = parsedSec * 1000;
          }
        }

        const rUser = await adapter.getHotspotUserData(targetRouter.endpoint, creds, normalized);
        if (rUser) {
          const limitSec = adapter.parseRouterOsDuration(rUser['limit-uptime']);
          const uptimeSec = adapter.parseRouterOsDuration(rUser.uptime);
          if (limitSec > 0 && routerRemainingMs === null) {
            routerRemainingMs = Math.max(0, limitSec - uptimeSec) * 1000;
          }
        }
      } catch {}
      const planLimit = (session as any)?.voucher?.plan?.dataLimitBytes ?? null;
      dataLimitBytes = planLimit ? Number(planLimit) : null;
    }

    if (!session && !live) {
      const venue = await this.venuesService.getDefaultVenue();
      const plans = await this.plansService.listPlans(venue.id);
      return {
        hasPaid: false,
        isConnectedOnRouter: false,
        walledGardenOpen: true,
        mac: normalized || null,
        ip: deviceIp,
        voucherCode: null,
        username: null,
        password: null,
        remainingMs: 0,
        dataUsedBytes: 0,
        dataLimitBytes: null,
        dataExhaustedPct: 0,
        paymentMethods: ['card', 'transfer', 'voucher'],
        voucherAccess: true,
        plans,
        message: normalized || deviceIp
          ? 'Not connected — choose a plan or enter voucher to open access.'
          : 'Open this page via hotspot login (http://example.com) so we can detect your device, or enter your voucher code.',
      };
    }

    const now = Date.now();
    const expiresAt = session?.expiresAt ? session.expiresAt.getTime() : now;
    const calcRemainingMs = Math.max(0, expiresAt - now);
    const remainingMs = routerRemainingMs !== null ? routerRemainingMs : calcRemainingMs;
    const hasPaid = remainingMs > 0;
    const pct = dataLimitBytes ? Math.min(100, Math.round((dataUsedBytes / dataLimitBytes) * 100)) : 0;
    const code = session?.voucher?.displayCodeEnc || session?.voucher?.id || live?.user || null;
    const credUser = code || normalized;

    return {
      hasPaid,
      isConnectedOnRouter,
      walledGardenOpen: true,
      mac: normalized,
      ip: deviceIp,
      sessionId: session?.id || `live_${normalized}`,
      voucherCode: code,
      username: credUser,
      password: credUser,
      planName: session?.voucher?.plan?.name || 'Internet Pass',
      remainingMs,
      expiresAt: session?.expiresAt || new Date(now + remainingMs),
      startedAt: session?.startedAt || new Date(),
      dataUsedBytes,
      dataLimitBytes,
      dataExhaustedPct: pct,
      dataExhausted: pct >= 100,
      paymentMethods: ['card', 'transfer', 'voucher'],
      voucherAccess: true,
      router: session?.router || targetRouter,
      reconnectUrl: `http://192.168.88.1/login?username=${encodeURIComponent(credUser)}&password=${encodeURIComponent(credUser)}`,
    };
  }

  async getSessionStatus(mac: string) {
    return this.getLandingStatus(mac);
  }

  /**
   * Resolves active access (allocated voucher or online pass) tied to a client MAC address.
   * Enables connected/reconnecting devices to view their assigned voucher and reconnect with 1 tap.
   */
  async getDeviceActiveAccess(mac?: string, ip?: string) {
    const normalized = (mac || '').toUpperCase().trim();
    if (!normalized && !ip) {
      return {
        hasActiveAccess: false,
        mac: null,
        source: null,
        voucherCode: null,
        username: null,
        password: null,
        planName: null,
        durationSeconds: 0,
        remainingMs: 0,
        remainingSeconds: 0,
        remainingFormatted: '00:00:00',
        expiresAt: null,
        startedAt: null,
        reconnectUrl: null,
        message: 'No device MAC address or IP provided',
      };
    }

    const now = Date.now();

    // 1. Probe MikroTik router directly for live user & active session
    let targetRouter = await this.prisma.router.findFirst({
      where: { status: 'ONLINE' },
      orderBy: { lastSeen: 'desc' },
    });

    let rActive: any = null;
    let rUser: any = null;
    let routerRemainingMs: number | null = null;
    let mikrotikAdapter: any = null;
    const mikrotikCreds = {
      username: process.env.MIKROTIK_API_USER || 'admin',
      password: process.env.MIKROTIK_API_PASS || '',
    };

    if (targetRouter?.endpoint) {
      try {
        const { MikrotikAdapter } = await import('../mikrotik/mikrotik.adapter');
        mikrotikAdapter = new MikrotikAdapter();

        const rows = await mikrotikAdapter.getActiveHotspotData(targetRouter.endpoint, mikrotikCreds);
        rActive = rows.find((r: any) =>
          (normalized && String(r['mac-address'] || r.mac || '').toUpperCase() === normalized) ||
          (normalized && String(r.user || '').toUpperCase() === normalized) ||
          (ip && String(r.address || r.ip || '') === ip)
        );

        if (rActive) {
          if (rActive['session-time-left']) {
            const parsed = mikrotikAdapter.parseRouterOsDuration(rActive['session-time-left']);
            if (parsed > 0) routerRemainingMs = parsed * 1000;
          }
          if (rActive.user) {
            rUser = await mikrotikAdapter.getHotspotUserData(targetRouter.endpoint, mikrotikCreds, rActive.user);
          }
        }

        if (!rUser && normalized) {
          rUser = await mikrotikAdapter.getHotspotUserData(targetRouter.endpoint, mikrotikCreds, normalized);
        }

        if (rUser) {
          const limitSec = mikrotikAdapter.parseRouterOsDuration(rUser['limit-uptime']);
          const uptimeSec = mikrotikAdapter.parseRouterOsDuration(rUser.uptime);
          if (limitSec > 0 && routerRemainingMs === null) {
            routerRemainingMs = Math.max(0, limitSec - uptimeSec) * 1000;
          }
        }
      } catch (err) {
        this.logger.warn(`Failed to inspect MikroTik router for client ${normalized}: ${(err as Error).message}`);
      }
    }

    // If active user or session is confirmed directly on MikroTik router
    if (rUser || rActive) {
      const remainingMs = routerRemainingMs !== null ? routerRemainingMs : 3600000;
      if (remainingMs > 0) {
        const u = rUser?.name || rActive?.user || normalized;
        const p = rUser?.password || u;
        return {
          hasActiveAccess: true,
          isConnectedOnRouter: !!rActive,
          mac: normalized || rActive?.['mac-address'] || rUser?.['mac-address'],
          source: 'mikrotik',
          voucherCode: u,
          username: u,
          password: p,
          planName: rUser?.profile || 'MikroTik HotSpot Pass',
          durationSeconds: Math.floor(remainingMs / 1000),
          remainingMs,
          remainingSeconds: Math.floor(remainingMs / 1000),
          remainingFormatted: this.formatRemaining(remainingMs),
          expiresAt: new Date(now + remainingMs).toISOString(),
          startedAt: null,
          reconnectUrl: `http://192.168.88.1/login?username=${encodeURIComponent(u)}&password=${encodeURIComponent(p)}`,
        };
      }
    }

    // 2. Check for active Session in database
    let session: any = null;
    if (normalized) {
      session = await this.prisma.session.findFirst({
        where: {
          mac: normalized,
          status: 'ACTIVE',
          OR: [{ expiresAt: { gt: new Date(now) } }, { expiresAt: null }],
        },
        include: {
          voucher: { include: { plan: true } },
          router: { select: { id: true, name: true, endpoint: true } },
        },
        orderBy: { startedAt: 'desc' },
      });
    }

    if (!session && ip) {
      session = await this.prisma.session.findFirst({
        where: {
          ip,
          status: 'ACTIVE',
          OR: [{ expiresAt: { gt: new Date(now) } }, { expiresAt: null }],
        },
        include: {
          voucher: { include: { plan: true } },
          router: { select: { id: true, name: true, endpoint: true } },
        },
        orderBy: { startedAt: 'desc' },
      });
    }

    // 3. Check for active redeemed Voucher tied to this MAC
    let activeVoucher: any = null;
    if (normalized) {
      const redeemedVouchers = await this.prisma.voucher.findMany({
        where: {
          redeemedMac: normalized,
          status: 'REDEEMED',
        },
        include: { plan: true, venue: true },
        orderBy: { redeemedAt: 'desc' },
        take: 5,
      });

      for (const v of redeemedVouchers) {
        const durationMs = (v.plan?.durationSeconds || 3600) * 1000;
        const expiry = v.expiresAt ? v.expiresAt.getTime() : (v.redeemedAt ? v.redeemedAt.getTime() + durationMs : 0);
        if (expiry > now) {
          activeVoucher = { ...v, calculatedExpiry: new Date(expiry) };
          break;
        }
      }
    }

    // 4. Check for active Paystack online order tied to this MAC
    let activeOrder: any = null;
    if (normalized) {
      const orders = await this.prisma.order.findMany({
        where: {
          customerRef: normalized,
          status: 'ACTIVE',
        },
        include: { plan: true, venue: true },
        orderBy: { createdAt: 'desc' },
        take: 5,
      });

      for (const ord of orders) {
        const durationMs = (ord.plan?.durationSeconds || 3600) * 1000;
        const expiry = ord.createdAt.getTime() + durationMs;
        if (expiry > now) {
          activeOrder = { ...ord, calculatedExpiry: new Date(expiry) };
          break;
        }
      }
    }

    // Prioritize voucher session if available - query router for live remaining time
    if (session && session.voucher) {
      const code = session.voucher.displayCodeEnc || session.voucher.id;
      let remainingMs = session.expiresAt ? Math.max(0, session.expiresAt.getTime() - now) : 3600000;

      if (targetRouter?.endpoint && mikrotikAdapter && code) {
        try {
          const rVch = await mikrotikAdapter.getHotspotUserData(targetRouter.endpoint, mikrotikCreds, code);
          if (rVch) {
            const limitSec = mikrotikAdapter.parseRouterOsDuration(rVch['limit-uptime']);
            const uptimeSec = mikrotikAdapter.parseRouterOsDuration(rVch.uptime);
            if (limitSec > 0) {
              remainingMs = Math.max(0, limitSec - uptimeSec) * 1000;
            }
          }
        } catch {}
      }

      return {
        hasActiveAccess: remainingMs > 0,
        isConnectedOnRouter: !!rActive,
        mac: normalized || session.mac,
        source: 'voucher',
        voucherCode: code,
        username: code,
        password: code,
        planName: session.voucher.plan?.name || 'Voucher Pass',
        durationSeconds: session.voucher.plan?.durationSeconds || 3600,
        remainingMs,
        remainingSeconds: Math.floor(remainingMs / 1000),
        remainingFormatted: this.formatRemaining(remainingMs),
        expiresAt: new Date(now + remainingMs).toISOString(),
        startedAt: session.startedAt ? session.startedAt.toISOString() : null,
        reconnectUrl: `http://192.168.88.1/login?username=${encodeURIComponent(code)}&password=${encodeURIComponent(code)}`,
      };
    }

    if (activeVoucher) {
      const code = activeVoucher.displayCodeEnc || activeVoucher.id;
      let remainingMs = Math.max(0, activeVoucher.calculatedExpiry.getTime() - now);

      if (targetRouter?.endpoint && mikrotikAdapter && code) {
        try {
          const rVch = await mikrotikAdapter.getHotspotUserData(targetRouter.endpoint, mikrotikCreds, code);
          if (rVch) {
            const limitSec = mikrotikAdapter.parseRouterOsDuration(rVch['limit-uptime']);
            const uptimeSec = mikrotikAdapter.parseRouterOsDuration(rVch.uptime);
            if (limitSec > 0) {
              remainingMs = Math.max(0, limitSec - uptimeSec) * 1000;
            }
          }
        } catch {}
      }

      return {
        hasActiveAccess: remainingMs > 0,
        isConnectedOnRouter: !!rActive,
        mac: normalized,
        source: 'voucher',
        voucherCode: code,
        username: code,
        password: code,
        planName: activeVoucher.plan?.name || 'Voucher Pass',
        durationSeconds: activeVoucher.plan?.durationSeconds || 3600,
        remainingMs,
        remainingSeconds: Math.floor(remainingMs / 1000),
        remainingFormatted: this.formatRemaining(remainingMs),
        expiresAt: new Date(now + remainingMs).toISOString(),
        startedAt: activeVoucher.redeemedAt ? activeVoucher.redeemedAt.toISOString() : null,
        reconnectUrl: `http://192.168.88.1/login?username=${encodeURIComponent(code)}&password=${encodeURIComponent(code)}`,
      };
    }

    if (session && !session.voucher) {
      const user = session.mac || normalized;
      const exp = session.expiresAt ? session.expiresAt.getTime() : (now + 3600000);
      const remainingMs = Math.max(0, exp - now);
      return {
        hasActiveAccess: remainingMs > 0,
        isConnectedOnRouter: !!rActive,
        mac: normalized || session.mac,
        source: 'online',
        voucherCode: null,
        username: user,
        password: user,
        planName: 'Online Pass',
        durationSeconds: 3600,
        remainingMs,
        remainingSeconds: Math.floor(remainingMs / 1000),
        remainingFormatted: this.formatRemaining(remainingMs),
        expiresAt: session.expiresAt ? session.expiresAt.toISOString() : new Date(exp).toISOString(),
        startedAt: session.startedAt ? session.startedAt.toISOString() : null,
        reconnectUrl: `http://192.168.88.1/login?username=${encodeURIComponent(user)}&password=${encodeURIComponent(user)}`,
      };
    }

    if (activeOrder) {
      const exp = activeOrder.calculatedExpiry.getTime();
      const remainingMs = Math.max(0, exp - now);
      const user = normalized;
      return {
        hasActiveAccess: remainingMs > 0,
        isConnectedOnRouter: !!rActive,
        mac: normalized,
        source: 'online',
        voucherCode: null,
        username: user,
        password: user,
        planName: activeOrder.plan?.name || 'Online Pass',
        durationSeconds: activeOrder.plan?.durationSeconds || 3600,
        remainingMs,
        remainingSeconds: Math.floor(remainingMs / 1000),
        remainingFormatted: this.formatRemaining(remainingMs),
        expiresAt: activeOrder.calculatedExpiry.toISOString(),
        startedAt: activeOrder.createdAt.toISOString(),
        reconnectUrl: `http://192.168.88.1/login?username=${encodeURIComponent(user)}&password=${encodeURIComponent(user)}`,
      };
    }

    return {
      hasActiveAccess: false,
      mac: normalized || null,
      source: null,
      voucherCode: null,
      username: null,
      password: null,
      planName: null,
      durationSeconds: 0,
      remainingMs: 0,
      remainingSeconds: 0,
      remainingFormatted: '00:00:00',
      expiresAt: null,
      startedAt: null,
      reconnectUrl: null,
    };
  }

  private formatRemaining(ms: number): string {
    if (ms <= 0) return '00:00:00';
    const totalSeconds = Math.floor(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (hours > 0) {
      return `${hours}h ${minutes}m ${seconds}s`;
    }
    return `${minutes}m ${seconds}s`;
  }
}

