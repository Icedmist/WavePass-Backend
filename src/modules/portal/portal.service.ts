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

    // 4. If offline/mock mode (no Paystack key) — single source of truth is PaystackService.isMock()
    const isMock = this.paystack.isMock();
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
      include: { order: { include: { plan: true } } },
    });

    // Atomically fulfill payment + create ACTIVE voucher so mock checkout verifies
    // even when no router is paired (provisioning would otherwise leave PROVISIONING with no voucher).
    const { createHash, randomInt } = await import('crypto');
    const mac = body.mac.toUpperCase();
    const isMac = /^([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2})$/.test(mac);
    const expiresAt = new Date(Date.now() + payment.order.plan.durationSeconds * 1000);
    let voucherCode = '';
    for (let attempt = 0; attempt < 5; attempt++) {
      voucherCode = String(randomInt(100000, 1000000));
      try {
        await this.prisma.$transaction([
          this.prisma.payment.update({
            where: { id: payment.id },
            data: { status: 'FULFILLED', paidAt: new Date() },
          }),
          this.prisma.voucher.create({
            data: {
              venueId: payment.order.venueId,
              planId: payment.order.planId,
              paymentId: payment.id,
              codeHash: createHash('sha256').update(voucherCode).digest('hex'),
              displayCodeEnc: voucherCode,
              status: 'ACTIVE',
              issuedAt: new Date(),
              redeemedAt: new Date(),
              expiresAt,
              redeemedMac: isMac ? mac : null,
              redeemedDeviceId: isMac ? mac : null,
              createdBy: 'simulate_payment',
            },
          }),
          this.prisma.order.update({
            where: { id: payment.orderId },
            data: { status: 'PROVISIONING' },
          }),
        ]);
        break;
      } catch (err: any) {
        if (err.code === 'P2002') continue;
        throw err;
      }
    }

    // Venue-owner notification (best effort)
    try {
      const db = this.prisma as any;
      if (db.notification) {
        const ngn = (payment.order.amountMinor / 100).toLocaleString('en-NG', { style: 'currency', currency: 'NGN' });
        await db.notification.create({
          data: {
            venueId: payment.order.venueId,
            type: 'PAYMENT',
            title: `Payment received — ${ngn}`,
            body: `${payment.order.plan?.name || 'Wi-Fi pass'} paid (${initResult.reference}). Voucher ${voucherCode} is active.`,
            amountMinor: payment.order.amountMinor,
            reference: initResult.reference,
          },
        });
      }
    } catch {}

    // Enqueue provisioning (allowed to fail — voucher already ACTIVE for router-sync)
    try {
      await this.provisioningQueue.enqueue({ orderId: payment.orderId });
    } catch (err: any) {
      this.logger.warn(`Provisioning enqueue failed after simulate: ${(err as Error).message}`);
    }

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

  async getDeviceActiveAccess(mac?: string, ip?: string, reference?: string) {
    return this.getLandingStatus(mac, ip, reference);
  }

  async getLandingStatus(mac?: string, ip?: string, reference?: string) {
    let normalized = (mac || '').toUpperCase().trim();
    let session: any = null;

    if (reference) {
      const payment = await this.prisma.payment.findUnique({
        where: { providerReference: reference },
        include: {
          order: { include: { plan: true, venue: { include: { routers: true } } } },
          vouchers: { include: { plan: true } },
        },
      });
      if (payment) {
        if (!normalized && payment.order.customerRef) {
          normalized = (payment.order.customerRef || '').toUpperCase().trim();
        }
        const v = payment.vouchers[0] || await this.prisma.voucher.findFirst({
          where: { paymentId: payment.id },
          include: { plan: true },
        });
        if (v) {
          const durationMs = (v.plan?.durationSeconds || payment.order.plan?.durationSeconds || 3600) * 1000;
          const expiry = v.expiresAt ? v.expiresAt.getTime() : (v.redeemedAt ? v.redeemedAt.getTime() + durationMs : Date.now() + durationMs);
          session = await this.prisma.session.findFirst({
            where: { orderId: payment.orderId },
            include: { router: { select: { id: true, name: true, endpoint: true } }, voucher: { include: { plan: true } } },
          }) || {
            id: `v_${v.id}`,
            mac: normalized || payment.order.customerRef,
            voucher: v,
            expiresAt: new Date(expiry),
            startedAt: v.redeemedAt || v.issuedAt || new Date(),
          };
        }
      }
    }

    if (!session && normalized) {
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

    // Fallback 2: check if device has a redeemed/active voucher even if session record was reset
    let activeVoucher: any = null;
    if (!session && normalized) {
      const redeemedVouchers = await this.prisma.voucher.findMany({
        where: { redeemedMac: normalized, status: { in: ['REDEEMED', 'ACTIVE'] } },
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
        // Backward-compat aliases for the legacy getDeviceActiveAccess shape
        // consumed by web portal/page.tsx (hasActiveAccess/remainingFormatted).
        hasActiveAccess: false,
        source: null,
        isConnectedOnRouter: false,
        walledGardenOpen: true,
        mac: normalized || null,
        ip: deviceIp,
        voucherCode: null,
        username: null,
        password: null,
        remainingMs: 0,
        remainingSeconds: 0,
        remainingFormatted: '00:00:00',
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
      // Backward-compat aliases for the legacy getDeviceActiveAccess shape
      // consumed by web portal/page.tsx (hasActiveAccess/remainingFormatted).
      hasActiveAccess: hasPaid,
      source: session?.voucher ? 'voucher' : live ? 'mikrotik' : session ? 'online' : null,
      isConnectedOnRouter,
      walledGardenOpen: true,
      mac: normalized,
      ip: deviceIp,
      sessionId: session?.id || `live_${normalized}`,
      voucherCode: code,
      username: credUser,
      password: credUser,
      planName: session?.voucher?.plan?.name || 'Internet Pass',
      durationSeconds: session?.voucher?.plan?.durationSeconds || Math.floor(remainingMs / 1000),
      remainingMs,
      remainingSeconds: Math.floor(remainingMs / 1000),
      remainingFormatted: this.formatRemaining(remainingMs),
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

  private profileForDuration(seconds: number, simultaneousDevices: number = 1): string {
    if (simultaneousDevices === 2) return 'profile_duo';
    if (simultaneousDevices > 2) return 'profile_family';

    if (seconds <= 1800) return 'profile_30m';
    if (seconds <= 3600) return 'profile_1h';
    if (seconds <= 7200) return 'profile_2h';
    if (seconds <= 10800) return 'profile_3h';
    if (seconds <= 21600) return 'profile_6h';
    if (seconds <= 43200) return 'profile_12h';
    if (seconds <= 86400) return 'profile_1d';
    if (seconds <= 604800) return 'profile_7d';
    return 'profile_30d';
  }

  private formatDuration(seconds: number): string {
    if (seconds >= 86400) return `${Math.floor(seconds / 86400)}d`;
    if (seconds >= 3600) return `${Math.floor(seconds / 3600)}h`;
    if (seconds >= 60) return `${Math.floor(seconds / 60)}m`;
    return `${seconds}s`;
  }

  async generateRouterSyncScript(venueSlug?: string, venueId?: string, format?: string) {
    const slug = venueSlug || 'flagship';
    const venue = venueId
      ? await this.prisma.venue.findUnique({ where: { id: venueId } })
      : await this.prisma.venue.findFirst({ where: { slug } });

    if (!venue) {
      if (format === 'json') return { status: 'error', message: 'Venue not found', activeVouchers: [] };
      return '# Error: Venue not found';
    }

    const now = new Date();
    const vouchers = await this.prisma.voucher.findMany({
      where: {
        venueId: venue.id,
        status: 'ACTIVE',
        OR: [{ expiresAt: { gt: now } }, { expiresAt: null }],
      },
      include: { plan: true },
      orderBy: { issuedAt: 'desc' },
      take: 100,
    });

    if (format === 'json') {
      return {
        venue: venue.name,
        slug: venue.slug,
        count: vouchers.length,
        vouchers: vouchers.map((v) => ({
          code: v.displayCodeEnc || v.id.slice(0, 8),
          mac: v.redeemedMac,
          profile: v.plan?.rateLimit || this.profileForDuration(v.plan?.durationSeconds || 3600, v.plan?.simultaneousDevices),
          durationSeconds: v.plan?.durationSeconds || 3600,
          expiresAt: v.expiresAt,
        })),
      };
    }

    // Generate RouterOS Script (v6 & v7 compatible)
    const commands: string[] = [
      `# ========================================================`,
      `# WavePass RouterOS Cloud Voucher Sync`,
      `# Venue: ${venue.name} (${venue.slug})`,
      `# Timestamp: ${now.toISOString()}`,
      `# Total Active Cloud Vouchers: ${vouchers.length}`,
      `# ========================================================`,
      `:do {`,
    ];

    for (const v of vouchers) {
      const code = v.displayCodeEnc || v.id.slice(0, 8);
      const durSec = v.plan?.durationSeconds || 3600;
      const durStr = this.formatDuration(durSec);
      const prof = v.plan?.rateLimit || this.profileForDuration(durSec, v.plan?.simultaneousDevices);
      const isSingle = (v.plan?.simultaneousDevices ?? 1) === 1;
      const macParam = isSingle && v.redeemedMac ? ` mac-address="${v.redeemedMac.toUpperCase()}"` : '';
      commands.push(
        `  :if ([:len [/ip hotspot user find name="${code}"]] = 0) do={ /ip hotspot user add name="${code}" password="${code}" profile="${prof}" limit-uptime=${durStr}${macParam} comment="WavePass Cloud Sync" }`,
      );
    }

    commands.push(`} on-error={ :log warning "WavePass cloud voucher sync partial error" }`);
    return commands.join('\n');
  }
}

