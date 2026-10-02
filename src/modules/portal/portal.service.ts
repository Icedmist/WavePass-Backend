import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
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

    let venueId = plan.venueId;
    if (dto.venueId && dto.venueId.trim() !== '' && dto.venueId !== 'null' && dto.venueId !== 'undefined') {
      try {
        const v = await this.prisma.venue.findFirst({
          where: {
            OR: [
              { id: dto.venueId },
              { slug: dto.venueId.toLowerCase().trim() },
            ],
          },
        });
        if (v) {
          venueId = v.id;
        }
      } catch (_) {
        venueId = plan.venueId;
      }
    }
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
      publicKey: (process.env.PAYSTACK_PUBLIC_KEY || '').trim(),
    };
  }

  async simulatePayment(body: { mac: string; planId: string; venueId?: string }) {
    // NEVER mint free vouchers on a live gateway — simulation exists for
    // mock/offline development only.
    if (!this.paystack.isMock()) {
      throw new ForbiddenException('Payment simulation is disabled on live gateways');
    }
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
      let payment = await this.prisma.payment.findUnique({
        where: { providerReference: reference },
        include: {
          order: { include: { plan: true, venue: { include: { routers: true } } } },
          vouchers: { include: { plan: true } },
        },
      });

      // Fallback verification: if payment exists but is still PENDING, re-verify with Paystack
      // in case the webhook was delayed, dropped, or failed signature checks.
      if (payment && payment.status === 'PENDING' && !this.paystack.isMock()) {
        try {
          const verified = await this.paystack.verifyTransaction(reference);
          if (verified.data.status === 'success' && verified.data.amount >= payment.order.amountMinor) {
            const { createHash, randomInt } = await import('crypto');
            const mac = normalized || payment.order.customerRef || '';
            const isMac = /^([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2})$/.test(mac);
            const durationSec = payment.order.plan.durationSeconds || 3600;
            const expiresAt = new Date(Date.now() + durationSec * 1000);
            let voucherCode = '';
            for (let attempt = 0; attempt < 5; attempt++) {
              voucherCode = String(randomInt(100000, 1000000));
              try {
                await this.prisma.$transaction([
                  this.prisma.payment.update({
                    where: { id: payment.id },
                    data: { status: 'FULFILLED', paidAt: new Date(), providerTransactionId: String(verified.data.id) },
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
                      createdBy: 'portal_reverify',
                    },
                  }),
                  this.prisma.order.update({
                    where: { id: payment.orderId },
                    data: { status: 'PROVISIONING' },
                  }),
                ]);
                try {
                  await this.provisioningQueue.enqueue({ orderId: payment.orderId });
                } catch {}
                break;
              } catch (err: any) {
                if (err.code === 'P2002') continue;
                break;
              }
            }
            payment = (await this.prisma.payment.findUnique({
              where: { id: payment.id },
              include: {
                order: { include: { plan: true, venue: { include: { routers: true } } } },
                vouchers: { include: { plan: true } },
              },
            })) || payment;
          }
        } catch (err: any) {
          this.logger.warn(`Reference verification on landing check error: ${err.message}`);
        }
      }

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
      router: session?.router || targetRouter,
      reconnectUrl: (() => {
        const effectiveRouter = session?.router || targetRouter;
        let hotspotHost = '10.5.50.1';
        if (effectiveRouter?.endpoint) {
          try {
            const ep = effectiveRouter.endpoint.startsWith('http') ? effectiveRouter.endpoint : `http://${effectiveRouter.endpoint}`;
            const u = new URL(ep);
            if (u.hostname && u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') {
              hotspotHost = u.hostname;
            }
          } catch {}
        } else if (deviceIp && (deviceIp.startsWith('192.168.88.') || deviceIp === '192.168.88.1')) {
          hotspotHost = '192.168.88.1';
        } else if (deviceIp && (deviceIp.startsWith('10.5.50.') || deviceIp === '10.5.50.1')) {
          hotspotHost = '10.5.50.1';
        }
        return `http://${hotspotHost}/login?username=${encodeURIComponent(credUser)}&password=${encodeURIComponent(credUser)}`;
      })(),
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

  /** Real device MAC (MAC-shaped and not the legacy shared dummy). */
  private isGuestMac(mac: string): boolean {
    return (
      /^([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2})$/.test(mac || '') &&
      (mac || '').toUpperCase() !== '02:00:00:00:00:01'
    );
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
    await this.prisma.voucher.updateMany({
      where: {
        expiresAt: { lt: now },
        status: { in: ['ISSUED', 'GENERATED'] },
      },
      data: { status: 'EXPIRED' },
    }).catch(() => {});

    const vouchers = await this.prisma.voucher.findMany({
      where: {
        venueId: venue.id,
        status: { in: ['ACTIVE', 'REDEEMED'] },
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
      if (v.redeemedMac) {
        commands.push(
          `  :if ([:len [/ip hotspot ip-binding find mac-address="${v.redeemedMac.toUpperCase()}"]] = 0) do={ /ip hotspot ip-binding add mac-address="${v.redeemedMac.toUpperCase()}" type=bypassed comment="WavePass:${code}" }`,
        );
      }
    }

    commands.push(
      `  :foreach b in=[/ip hotspot ip-binding find type=bypassed] do={ :local bc [/ip hotspot ip-binding get $b comment]; :if ([:len $bc] > 9) do={ :local bu [:pick $bc 9 [:len $bc]]; :if ([:len [/ip hotspot user find name=$bu]] = 0) do={ /ip hotspot ip-binding remove $b; } } };`,
    );

    commands.push(`} on-error={ :log warning "WavePass cloud voucher sync partial error" }`);
    return commands.join('\n');
  }

  async getPortalVenueInfo(venueIdOrSlug?: string) {
    let venue: any = null;
    if (venueIdOrSlug) {
      try {
        venue = await this.venuesService.getVenueBySlug(venueIdOrSlug.toLowerCase().trim());
      } catch {
        try {
          venue = await this.venuesService.getVenueById(venueIdOrSlug);
        } catch {}
      }
    }
    if (!venue) {
      venue = await this.venuesService.getDefaultVenue();
    }

    const plans = await this.plansService.listPlans(venue.id);
    const bankAccounts = await this.prisma.bankAccount.findMany({
      where: { venueId: venue.id },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
      select: {
        id: true,
        accountName: true,
        accountNumber: true,
        bankName: true,
        bankCode: true,
        isDefault: true,
      },
    });

    return {
      venue: { id: venue.id, name: venue.name, slug: venue.slug, logoUrl: venue.logoUrl },
      plans,
      bankAccounts,
    };
  }

  async submitTransferRequest(dto: {
    venueSlug?: string;
    venueId?: string;
    mac: string;
    planId: string;
    senderName?: string;
    amountMinor?: number;
    bankAccount?: string;
    notes?: string;
  }) {
    const venueKey = dto.venueSlug || dto.venueId;
    let venue: any = null;
    if (venueKey) {
      try {
        venue = await this.venuesService.getVenueBySlug(venueKey.toLowerCase().trim());
      } catch {
        try {
          venue = await this.venuesService.getVenueById(venueKey);
        } catch {}
      }
    }
    if (!venue) {
      venue = await this.venuesService.getDefaultVenue();
    }

    let plan: any;
    try {
      plan = await this.plansService.getPlanById(dto.planId);
    } catch {
      throw new NotFoundException(`Plan ${dto.planId} not found`);
    }

    const mac = (dto.mac || '').toUpperCase().trim();
    if (!this.isGuestMac(mac)) {
      throw new BadRequestException(
        'Valid device MAC required — open this page from the venue Wi-Fi so we can detect your device.',
      );
    }
    const amount = dto.amountMinor || plan.priceMinor;
    const ref = `TRF-${Date.now().toString(36).toUpperCase()}-${mac.replace(/[:-]/g, '').slice(-4)}`;

    const order = await this.prisma.order.create({
      data: {
        venueId: venue.id,
        planId: plan.id,
        customerRef: mac,
        amountMinor: amount,
        paymentProvider: 'bank_transfer',
        status: 'AWAITING_PAYMENT',
      },
    });

    const ngn = `₦${Math.round(amount / 100).toLocaleString('en-NG')}`;
    const sender = dto.senderName?.trim() || 'Guest';

    // Create Notification for the venue owner
    const db = this.prisma as any;
    let notification: any = null;
    if (db.notification) {
      notification = await db.notification.create({
        data: {
          venueId: venue.id,
          type: 'PAYMENT',
          title: `Transfer Request — ${ngn}`,
          body: `${sender} sent ${ngn} via transfer for ${plan.name} (${mac}). Tap or use Notification Panel to Approve Access.`,
          amountMinor: amount,
          reference: `TRANSFER_APPROVAL:${order.id}:${mac}:${plan.id}:${venue.id}`,
        },
      });
    }

    return {
      ok: true,
      orderId: order.id,
      reference: ref,
      notificationId: notification?.id,
      message: 'Transfer request submitted. Awaiting venue owner approval.',
    };
  }

  async approveAccess(dto: {
    venueId: string;
    orderId?: string;
    mac: string;
    planId?: string;
    reference?: string;
  }) {
    let order: any = null;
    if (dto.orderId) {
      order = await this.prisma.order.findUnique({
        where: { id: dto.orderId },
        include: { plan: true, venue: true },
      });
    } else if (dto.reference?.startsWith('TRANSFER_APPROVAL:')) {
      const parts = dto.reference.split(':');
      const orderId = parts[1];
      order = await this.prisma.order.findUnique({
        where: { id: orderId },
        include: { plan: true, venue: true },
      });
    }

    if (!order) {
      order = await this.prisma.order.findFirst({
        where: {
          venueId: dto.venueId,
          customerRef: dto.mac.toUpperCase().trim(),
          status: 'AWAITING_PAYMENT',
        },
        include: { plan: true, venue: true },
        orderBy: { createdAt: 'desc' },
      });
    }

    if (!order) {
      const planId = dto.planId || (await this.plansService.listPlans(dto.venueId))[0]?.id;
      if (!planId) throw new NotFoundException('No plans found for venue');
      const plan = await this.plansService.getPlanById(planId);
      order = await this.prisma.order.create({
        data: {
          venueId: plan.venueId,
          planId: plan.id,
          customerRef: dto.mac.toUpperCase().trim(),
          amountMinor: plan.priceMinor,
          paymentProvider: 'bank_transfer',
          status: 'PAID',
        },
        include: { plan: true, venue: true },
      });
    } else {
      await this.prisma.order.update({
        where: { id: order.id },
        data: { status: 'PAID' },
      });
    }

    const { createHash, randomInt } = await import('crypto');
    // Resolve the effective guest MAC: the approval request wins, otherwise
    // fall back to the order's stored ref (and repair it when it was a dummy).
    // The voucher MUST bind the real device MAC or the guest polling by MAC
    // will never see the approved access.
    const dtoMac = (dto.mac || '').toUpperCase().trim();
    const orderMac = (order.customerRef || '').toUpperCase().trim();
    const mac = this.isGuestMac(dtoMac) ? dtoMac : orderMac;
    if (!this.isGuestMac(mac)) {
      throw new BadRequestException(
        'Valid guest device MAC required — approval must carry the guest MAC when the order has none.',
      );
    }
    if (orderMac !== mac) {
      await this.prisma.order.update({ where: { id: order.id }, data: { customerRef: mac } });
    }

    // Idempotent re-approval: a retry/double-tap returns the existing voucher
    // instead of minting duplicates.
    const priorPayment = await this.prisma.payment.findUnique({
      where: { orderId: order.id },
      include: { vouchers: true },
    });
    if (priorPayment?.status === 'FULFILLED' && priorPayment.vouchers.length > 0) {
      const prior = priorPayment.vouchers[0];
      this.logger.log(`Duplicate approval for order ${order.id} — returning existing voucher.`);
      return {
        ok: true,
        alreadyApproved: true,
        voucherCode: prior.displayCodeEnc,
        mac,
        planName: order.plan?.name,
        durationSeconds: order.plan?.durationSeconds || 3600,
        expiresAt: prior.expiresAt,
        message: 'Access was already approved — showing existing voucher.',
      };
    }
    const durationSeconds = order.plan?.durationSeconds || 3600;
    const expiresAt = new Date(Date.now() + durationSeconds * 1000);

    const payment = await this.prisma.payment.create({
      data: {
        orderId: order.id,
        provider: 'bank_transfer',
        providerReference: `BT-${Date.now()}-${mac.replace(/[:-]/g, '').slice(-4)}`,
        amountMinor: order.amountMinor,
        status: 'FULFILLED',
        channel: 'transfer',
        paidAt: new Date(),
      },
    });

    let voucherCode = '';
    for (let attempt = 0; attempt < 5; attempt++) {
      voucherCode = String(randomInt(100000, 1000000));
      try {
        await this.prisma.voucher.create({
          data: {
            venueId: order.venueId,
            planId: order.planId,
            paymentId: payment.id,
            codeHash: createHash('sha256').update(voucherCode).digest('hex'),
            displayCodeEnc: voucherCode,
            status: 'ACTIVE',
            issuedAt: new Date(),
            redeemedAt: new Date(),
            expiresAt,
            redeemedMac: mac,
            redeemedDeviceId: mac,
            createdBy: 'bank_transfer_approval',
          },
        });
        break;
      } catch (err: any) {
        if (err.code === 'P2002') continue;
        throw err;
      }
    }

    // Provision router hotspot user
    try {
      await this.provisioningQueue.enqueue({ orderId: order.id });
    } catch (err: any) {
      this.logger.warn(`Provisioning queue failed on approveAccess: ${(err as Error).message}`);
    }

    // Mark approval notification as read
    try {
      const db = this.prisma as any;
      if (db.notification && order.id) {
        await db.notification.updateMany({
          where: { venueId: order.venueId, reference: { contains: order.id } },
          data: { read: true },
        });
      }
    } catch {}

    return {
      ok: true,
      voucherCode,
      mac,
      planName: order.plan?.name,
      durationSeconds,
      expiresAt,
      message: 'Access approved and voucher generated.',
    };
  }

  async retrieveVoucher(query: {
    mac?: string;
    q?: string;
    venueId?: string;
    phone?: string;
    reference?: string;
    sender?: string;
  }) {
    const rawSearch = (query.q || query.phone || query.reference || query.sender || '').trim();
    const rawMac = (query.mac || '').trim();

    // 1. Resolve venue by ID or slug if provided
    let venue: any = null;
    const venueKey = query.venueId;
    if (venueKey) {
      try {
        venue = await this.venuesService.getVenueBySlug(venueKey.toLowerCase().trim());
      } catch {
        try {
          venue = await this.venuesService.getVenueById(venueKey);
        } catch {}
      }
    }
    const resolvedVenueId = venue?.id || (venueKey && venueKey.includes('-') && venueKey.length > 25 ? venueKey : undefined);
    const venueFilter = resolvedVenueId ? { venueId: resolvedVenueId } : {};

    // 2. Normalize MACs: caller MAC and potential query MAC
    let callerMac: string | null = null;
    if (rawMac && this.isGuestMac(rawMac)) {
      callerMac = rawMac.replace(/-/g, ':').toUpperCase();
    }

    let searchMac: string | null = null;
    if (rawSearch && this.isGuestMac(rawSearch)) {
      searchMac = rawSearch.replace(/-/g, ':').toUpperCase();
    }

    const effectiveMac = callerMac || searchMac;

    // Helper to format remaining time
    const formatRemaining = (expiresAt: Date): string => {
      const remainingMs = Math.max(0, expiresAt.getTime() - Date.now());
      const totalSec = Math.floor(remainingMs / 1000);
      const hours = Math.floor(totalSec / 3600);
      const mins = Math.floor((totalSec % 3600) / 60);
      const secs = totalSec % 60;
      if (hours > 0) return `${hours}h ${mins}m`;
      return `${mins}m ${secs}s`;
    };

    // Helper to safely format found voucher response and optionally re-bind to current device MAC
    const returnFoundVoucher = async (v: any, fallbackPlanName?: string) => {
      const durMs = (v.plan?.durationSeconds || 3600) * 1000;
      const expTime = v.expiresAt ? v.expiresAt.getTime() : (v.redeemedAt ? v.redeemedAt.getTime() + durMs : Date.now() + durMs);
      const expDate = new Date(expTime);

      // Re-bind to caller's device MAC if provided and changed (vital for iOS Private MAC & device handover)
      if (callerMac && v.redeemedMac !== callerMac) {
        try {
          await this.prisma.voucher.update({
            where: { id: v.id },
            data: { redeemedMac: callerMac, redeemedDeviceId: callerMac },
          });
          if (v.paymentId) {
            const ord = await this.prisma.order.findFirst({ where: { payment: { id: v.paymentId } } });
            if (ord) {
              await this.provisioningQueue.enqueue({ orderId: ord.id }).catch(() => {});
            }
          }
        } catch {}
      }

      const code = v.displayCodeEnc || v.codeHash?.slice(0, 6) || 'ACTIVE';
      return {
        found: true,
        voucherCode: code,
        username: code,
        planName: v.plan?.name || fallbackPlanName || 'Active Plan',
        expiresAt: expDate,
        remainingSeconds: Math.max(0, Math.floor((expTime - Date.now()) / 1000)),
        remainingFormatted: formatRemaining(expDate),
        status: v.status || 'ACTIVE',
        mac: callerMac || v.redeemedMac || undefined,
      };
    };

    // 3. Search Strategy A: Lookup by MAC address (either callerMac or searchMac)
    if (effectiveMac) {
      const altMac = effectiveMac.replace(/:/g, '-');
      const activeVouchers = await this.prisma.voucher.findMany({
        where: {
          OR: [
            { redeemedMac: effectiveMac },
            { redeemedMac: altMac },
            { redeemedDeviceId: effectiveMac },
          ],
          status: { in: ['ACTIVE', 'REDEEMED'] },
          ...venueFilter,
        },
        include: { plan: true },
        orderBy: { redeemedAt: 'desc' },
        take: 3,
      });

      const now = Date.now();
      for (const v of activeVouchers) {
        const durMs = (v.plan?.durationSeconds || 3600) * 1000;
        const exp = v.expiresAt ? v.expiresAt.getTime() : (v.redeemedAt ? v.redeemedAt.getTime() + durMs : 0);
        if (exp > now) {
          return returnFoundVoucher(v);
        }
      }

      // Check pending bank transfer order for this MAC
      const pendingOrder = await this.prisma.order.findFirst({
        where: {
          OR: [
            { customerRef: effectiveMac },
            { customerRef: altMac },
          ],
          status: 'AWAITING_PAYMENT',
          paymentProvider: 'bank_transfer',
          ...venueFilter,
        },
        include: { plan: true },
        orderBy: { createdAt: 'desc' },
      });

      if (pendingOrder) {
        return {
          found: false,
          pendingApproval: true,
          planName: pendingOrder.plan?.name,
          amountMinor: pendingOrder.amountMinor,
          message: 'Your transfer is pending approval by the venue owner. Wi-Fi will connect automatically once approved.',
        };
      }
    }

    // 4. Search Strategy B: Lookup by Query (Code, Phone, Transfer Reference, Sender Name)
    if (rawSearch) {
      const cleanCode = rawSearch.toUpperCase().replace(/\s+/g, '');

      // B1. Direct Voucher Code match (displayCodeEnc or codeHash)
      const v = await this.prisma.voucher.findFirst({
        where: {
          OR: [
            { displayCodeEnc: cleanCode },
            { codeHash: cleanCode },
            { codeHash: { startsWith: cleanCode.toLowerCase() } },
          ],
          ...venueFilter,
        },
        include: { plan: true },
      });

      if (v) {
        const durMs = (v.plan?.durationSeconds || 3600) * 1000;
        const exp = v.expiresAt ? v.expiresAt.getTime() : (v.redeemedAt ? v.redeemedAt.getTime() + durMs : Date.now() + durMs);
        if (exp > Date.now()) {
          return returnFoundVoucher(v);
        }
      }

      // B2. Payment Provider Reference match (e.g. TRF-..., BT-..., Paystack reference)
      const payment = await this.prisma.payment.findFirst({
        where: {
          OR: [
            { providerReference: { equals: rawSearch, mode: 'insensitive' } },
            { providerReference: { contains: rawSearch, mode: 'insensitive' } },
          ],
        },
        include: {
          order: { include: { plan: true } },
          vouchers: { include: { plan: true } },
        },
      });

      if (payment) {
        if (payment.vouchers && payment.vouchers.length > 0) {
          const pv = payment.vouchers[0];
          const durMs = (pv.plan?.durationSeconds || payment.order?.plan?.durationSeconds || 3600) * 1000;
          const exp = pv.expiresAt ? pv.expiresAt.getTime() : (pv.redeemedAt ? pv.redeemedAt.getTime() + durMs : Date.now() + durMs);
          if (exp > Date.now()) {
            return returnFoundVoucher(pv, payment.order?.plan?.name);
          }
        }
        if (payment.status === 'PENDING' || payment.order?.status === 'AWAITING_PAYMENT') {
          return {
            found: false,
            pendingApproval: true,
            planName: payment.order?.plan?.name,
            amountMinor: payment.amountMinor,
            message: 'Your transfer is pending approval by the venue owner. Wi-Fi will connect automatically once approved.',
          };
        }
      }

      // B3. Order match (by customerRef containing phone/ref, or ID)
      const matchingOrders = await this.prisma.order.findMany({
        where: {
          OR: [
            { id: rawSearch },
            { customerRef: { contains: rawSearch, mode: 'insensitive' } },
          ],
          ...venueFilter,
        },
        include: {
          plan: true,
          payment: { include: { vouchers: { include: { plan: true } } } },
        },
        orderBy: { createdAt: 'desc' },
        take: 3,
      });

      for (const ord of matchingOrders) {
        if (ord.payment?.vouchers && ord.payment.vouchers.length > 0) {
          const ov = ord.payment.vouchers[0];
          const durMs = (ov.plan?.durationSeconds || ord.plan?.durationSeconds || 3600) * 1000;
          const exp = ov.expiresAt ? ov.expiresAt.getTime() : (ov.redeemedAt ? ov.redeemedAt.getTime() + durMs : Date.now() + durMs);
          if (exp > Date.now()) {
            return returnFoundVoucher(ov, ord.plan?.name);
          }
        } else if (ord.status === 'AWAITING_PAYMENT') {
          return {
            found: false,
            pendingApproval: true,
            planName: ord.plan?.name,
            amountMinor: ord.amountMinor,
            message: 'Your transfer is pending approval by the venue owner. Wi-Fi will connect automatically once approved.',
          };
        }
      }

      // B4. Notification search for sender name / phone notes
      const db = this.prisma as any;
      if (db.notification && rawSearch.length >= 3) {
        const notifs = await db.notification.findMany({
          where: {
            OR: [
              { body: { contains: rawSearch, mode: 'insensitive' } },
              { reference: { contains: rawSearch, mode: 'insensitive' } },
            ],
            ...venueFilter,
          },
          orderBy: { createdAt: 'desc' },
          take: 3,
        });

        for (const notif of notifs) {
          if (notif.reference?.startsWith('TRANSFER_APPROVAL:')) {
            const parts = notif.reference.split(':');
            const orderId = parts[1];
            if (orderId) {
              const ord = await this.prisma.order.findUnique({
                where: { id: orderId },
                include: {
                  plan: true,
                  payment: { include: { vouchers: { include: { plan: true } } } },
                },
              });
              if (ord) {
                if (ord.payment?.vouchers && ord.payment.vouchers.length > 0) {
                  const nv = ord.payment.vouchers[0];
                  const durMs = (nv.plan?.durationSeconds || ord.plan?.durationSeconds || 3600) * 1000;
                  const exp = nv.expiresAt ? nv.expiresAt.getTime() : (nv.redeemedAt ? nv.redeemedAt.getTime() + durMs : Date.now() + durMs);
                  if (exp > Date.now()) {
                    return returnFoundVoucher(nv, ord.plan?.name);
                  }
                } else if (ord.status === 'AWAITING_PAYMENT') {
                  return {
                    found: false,
                    pendingApproval: true,
                    planName: ord.plan?.name,
                    amountMinor: ord.amountMinor,
                    message: 'Your transfer is pending approval by the venue owner. Wi-Fi will connect automatically once approved.',
                  };
                }
              }
            }
          }
        }
      }
    }

    return {
      found: false,
      message: 'No active pass found. Please buy a pass or enter a valid voucher code or transfer reference.',
    };
  }
}


