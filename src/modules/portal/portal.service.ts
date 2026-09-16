import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';
import { PaystackService } from '../paystack/paystack.service';
import { MikrotikProvisioningQueue } from '../mikrotik/mikrotik-provisioning.queue';
import { InitPaymentDto } from './dto/init-payment.dto';
import { PlansService } from '../plans/plans.service';
import { VenuesService } from '../venues/venues.service';

@Injectable()
export class PortalService {
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
    const customerEmail = dto.email || `hotspot_${mac.replace(/[:-]/g, '')}@wavepass.local`;

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
    let live: any = null;
    let dataUsedBytes = 0;
    let dataLimitBytes: number | null = null;
    let deviceIp = ip || session?.ip || null;
    if (session?.router?.endpoint) {
      try {
        const { MikrotikAdapter } = await import('../mikrotik/mikrotik.adapter');
        const adapter = new MikrotikAdapter();
        const rows = await adapter.getActiveHotspotData(session.router.endpoint, {
          username: process.env.MIKROTIK_API_USER || 'wavepass',
          password: process.env.MIKROTIK_API_PASS || '',
        });
        live = rows.find((r: any) => String(r['mac-address'] || r.mac || '').toUpperCase() === normalized || String(r.user || '').toUpperCase() === normalized);
        if (live) {
          deviceIp = live.address || live.ip || deviceIp;
          dataUsedBytes = Number(live['bytes-in'] || 0) + Number(live['bytes-out'] || 0);
        }
      } catch {}
      const planLimit = (session as any)?.voucher?.plan?.dataLimitBytes ?? null;
      dataLimitBytes = planLimit ? Number(planLimit) : null;
    }

    if (!session) {
      const venue = await this.venuesService.getDefaultVenue();
      const plans = await this.plansService.listPlans(venue.id);
      return {
        hasPaid: false,
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
    const expiresAt = session.expiresAt ? session.expiresAt.getTime() : now;
    const remainingMs = Math.max(0, expiresAt - now);
    const hasPaid = remainingMs > 0;
    const pct = dataLimitBytes ? Math.min(100, Math.round((dataUsedBytes / dataLimitBytes) * 100)) : 0;
    const code = session.voucher?.displayCodeEnc || session.voucher?.id || null;
    const credUser = code || normalized;

    return {
      hasPaid,
      walledGardenOpen: true,
      mac: normalized,
      ip: deviceIp,
      sessionId: session.id,
      voucherCode: code,
      username: credUser,
      password: credUser,
      planName: session.voucher?.plan?.name || 'Internet Pass',
      remainingMs,
      expiresAt: session.expiresAt,
      startedAt: session.startedAt,
      dataUsedBytes,
      dataLimitBytes,
      dataExhaustedPct: pct,
      dataExhausted: pct >= 100,
      paymentMethods: ['card', 'transfer', 'voucher'],
      voucherAccess: true,
      router: session.router,
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

    // 1. Check for active Session in database
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

    // 2. Check for active redeemed Voucher tied to this MAC
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

    // 3. Check for active Paystack online order tied to this MAC
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

    // Prioritize voucher session if available
    if (session && session.voucher) {
      const exp = session.expiresAt ? session.expiresAt.getTime() : (now + 3600000);
      const remainingMs = Math.max(0, exp - now);
      const code = session.voucher.displayCodeEnc || session.voucher.id;
      return {
        hasActiveAccess: remainingMs > 0,
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
        expiresAt: session.expiresAt ? session.expiresAt.toISOString() : new Date(exp).toISOString(),
        startedAt: session.startedAt ? session.startedAt.toISOString() : null,
        reconnectUrl: `http://192.168.88.1/login?username=${encodeURIComponent(code)}&password=${encodeURIComponent(code)}`,
      };
    }

    if (activeVoucher) {
      const exp = activeVoucher.calculatedExpiry.getTime();
      const remainingMs = Math.max(0, exp - now);
      const code = activeVoucher.displayCodeEnc || activeVoucher.id;
      return {
        hasActiveAccess: remainingMs > 0,
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
        expiresAt: activeVoucher.calculatedExpiry.toISOString(),
        startedAt: activeVoucher.redeemedAt ? activeVoucher.redeemedAt.toISOString() : null,
        reconnectUrl: `http://192.168.88.1/login?username=${encodeURIComponent(code)}&password=${encodeURIComponent(code)}`,
      };
    }

    if (session && !session.voucher) {
      const exp = session.expiresAt ? session.expiresAt.getTime() : (now + 3600000);
      const remainingMs = Math.max(0, exp - now);
      const user = session.mac || normalized;
      return {
        hasActiveAccess: remainingMs > 0,
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

