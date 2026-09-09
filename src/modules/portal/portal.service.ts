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

  async getLandingStatus(mac: string, ip?: string) {
    const normalized = mac.toUpperCase().trim();
    const session = await this.prisma.session.findFirst({
      where: { mac: normalized, status: 'ACTIVE' },
      include: { router: { select: { id: true, name: true, endpoint: true } }, voucher: { include: { plan: true } } },
      orderBy: { startedAt: 'desc' },
    });

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
        mac: normalized,
        ip: deviceIp,
        remainingMs: 0,
        dataUsedBytes: 0,
        dataLimitBytes: null,
        dataExhaustedPct: 0,
        paymentMethods: ['card', 'transfer', 'voucher'],
        voucherAccess: true,
        plans,
        message: 'Not connected — choose a plan or enter voucher to open access.',
      };
    }

    const now = Date.now();
    const expiresAt = session.expiresAt ? session.expiresAt.getTime() : now;
    const remainingMs = Math.max(0, expiresAt - now);
    const hasPaid = remainingMs > 0;
    const pct = dataLimitBytes ? Math.min(100, Math.round((dataUsedBytes / dataLimitBytes) * 100)) : 0;

    return {
      hasPaid,
      walledGardenOpen: true,
      mac: normalized,
      ip: deviceIp,
      sessionId: session.id,
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
    };
  }

  async getSessionStatus(mac: string) {
    return this.getLandingStatus(mac);
  }
}
