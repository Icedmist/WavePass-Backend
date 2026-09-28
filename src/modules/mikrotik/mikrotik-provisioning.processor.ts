import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger } from '@nestjs/common';
import { createHash, randomBytes, randomInt } from 'crypto';
import { PrismaService } from '../../common/prisma.service';
import { MikrotikAdapter } from './mikrotik.adapter';
import { NotificationsService } from '../notifications/notifications.service';

@Processor('mikrotik-provisioning')
export class MikrotikProvisioningProcessor extends WorkerHost {
  private readonly logger = new Logger(MikrotikProvisioningProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mikrotik: MikrotikAdapter,
    private readonly notifications?: NotificationsService,
  ) {
    super();
  }

  async process(job: Job<{ orderId?: string; voucherId?: string }>) {
    const { orderId, voucherId } = job.data;

    if (orderId) return this.provisionForOrder(orderId);
    if (voucherId) return this.provisionForVoucher(voucherId);
  }

  private selectBestRouter(routers: any[], venueId: string) {
    if (!routers || routers.length === 0) {
      this.logger.error(`No router registered for venue ${venueId}; retrying`);
      throw new Error('No router available');
    }

    const isDev = process.env.NODE_ENV === 'development';
    const candidateRouters = routers.filter(
      (r) => r.endpoint && (!r.endpoint.includes('localhost') && !r.endpoint.includes('127.0.0.1') || isDev),
    );
    const pool = candidateRouters.length > 0 ? candidateRouters : routers;
    const selected = pool.find((r) => r.status === 'ONLINE') || pool[0] || routers[0];
    if (!selected) {
      this.logger.error(`No candidate router available for venue ${venueId}`);
      throw new Error('No router available');
    }
    return selected;
  }

  private async provisionForOrder(orderId: string) {
    const order = await this.prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      include: { plan: true, venue: { include: { routers: true } } },
    });

    let router: any = null;
    try {
      router = this.selectBestRouter(order.venue.routers, order.venueId);
    } catch (err: any) {
      // Offline / not-yet-paired venue: voucher must still exist so checkout verifies
      // and the router can pull it later via GET /portal/router-sync.
      this.logger.warn(`No router for venue ${order.venueId} — creating cloud voucher without hardware push.`);
    }

    // Retrieve or create the allocated Voucher for this order
    const payment = this.prisma.payment ? await this.prisma.payment.findUnique({ where: { orderId: order.id } }) : null;
    let voucher = (payment && this.prisma.voucher) ? await this.prisma.voucher.findFirst({ where: { paymentId: payment.id } }) : null;
    const isMac = order.customerRef && /^([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2})$/.test(order.customerRef);
    const expiresAt = new Date(Date.now() + order.plan.durationSeconds * 1000);

    if (!voucher && this.prisma.voucher?.create) {
      for (let attempt = 0; attempt < 5 && !voucher; attempt++) {
        const voucherCode = String(randomInt(100000, 1000000));
        const codeHash = createHash('sha256').update(voucherCode).digest('hex');
        try {
          voucher = await this.prisma.voucher.create({
            data: {
              venueId: order.venueId,
              planId: order.planId,
              paymentId: payment?.id,
              codeHash,
              displayCodeEnc: voucherCode,
              status: 'ACTIVE',
              issuedAt: new Date(),
              redeemedAt: new Date(),
              expiresAt,
              redeemedMac: isMac ? order.customerRef!.toUpperCase() : null,
              redeemedDeviceId: isMac ? order.customerRef!.toUpperCase() : null,
              createdBy: 'paystack_online',
            },
          });
        } catch (err: any) {
          if (err.code === 'P2002' && attempt < 4) continue;
          throw err;
        }
      }
    }

    if (!router) {
      await this.prisma.order.update({ where: { id: order.id }, data: { status: 'ACTIVE' } });
      this.logger.log(`Order ${order.id} marked ACTIVE without router session (voucher ${voucher?.displayCodeEnc} ready for router-sync).`);
      try {
        await this.notifications?.provisioningDelayed(order.venueId, order.id, 'no router paired');
      } catch {}
      return;
    }

    // The voucher CODE is the single credential everywhere (portal auto-login,
    // success page, retrieve-voucher, reconnect, QR, print). MAC-bound plans
    // still enforce single-device via the mac-address field below — never by
    // overloading the username, which previously stranded paying guests with
    // a code the router would reject.
    const username = voucher?.displayCodeEnc || `wp_${randomBytes(4).toString('hex')}`;
    const password = voucher?.displayCodeEnc || randomBytes(6).toString('hex');
    const profile = order.plan.rateLimit || this.profileForDuration(order.plan.durationSeconds, order.plan.simultaneousDevices);

    // Option A: Bind strictly to device MAC address for single-device orders (simultaneousDevices === 1)
    const isSingleDevice = (order.plan.simultaneousDevices ?? 1) === 1;
    const macAddress = isSingleDevice && isMac ? order.customerRef!.toUpperCase() : undefined;

    try {
      await this.mikrotik.createHotspotUser(
        router.endpoint,
        this.getRouterCredentials(),
        {
          username,
          password,
          profile,
          sessionTimeoutSeconds: order.plan.durationSeconds,
          limitBytesTotal: order.plan.dataLimitBytes ? Number(order.plan.dataLimitBytes) : undefined,
          sharedUsers: order.plan.simultaneousDevices,
          macAddress,
        },
      );
      if (macAddress && typeof this.mikrotik.addIpBinding === 'function') {
        try {
          await this.mikrotik.addIpBinding(
            router.endpoint,
            this.getRouterCredentials(),
            {
              macAddress,
              type: 'bypassed',
              comment: `WP:${username}`,
            },
          );
        } catch (ipErr: any) {
          this.logger.warn(`Failed to add bypassed IP-binding for ${macAddress}: ${ipErr.message}`);
        }
      }
    } catch (err: any) {
      // Degrade, never fail the order: the cloud voucher is the source of
      // truth and stays usable via router-sync pull + portal code login.
      // Reconcile self-heals the hardware user later. Only DB errors rethrow.
      this.logger.warn(`Router push failed for ${router.endpoint}: ${err.message}. Order ${order.id} proceeds ACTIVE with cloud voucher ${voucher?.displayCodeEnc || username}.`);
      try {
        await this.notifications?.provisioningDelayed(order.venueId, order.id, err.message || 'router unreachable');
      } catch {}
    }

    // Idempotent: a retried job must never duplicate sessions for one order.
    const existingSession = await this.prisma.session.findFirst({ where: { orderId: order.id } });
    if (existingSession) {
      await this.prisma.order.update({ where: { id: order.id }, data: { status: 'ACTIVE' } });
      this.logger.log(`Order ${order.id} already has session ${existingSession.id} — marked ACTIVE, no duplicate.`);
      return;
    }

    await this.prisma.$transaction([
      this.prisma.session.create({
        data: {
          venueId: order.venueId,
          routerId: router.id,
          voucherId: voucher?.id || null,
          orderId: order.id,
          mac: isMac ? order.customerRef!.toUpperCase() : null,
          deviceId: isMac ? order.customerRef!.toUpperCase() : null,
          expiresAt,
        },
      }),
      this.prisma.order.update({ where: { id: order.id }, data: { status: 'ACTIVE' } }),
    ]);
  }

  private getRouterCredentials() {
    return {
      username: process.env.MIKROTIK_API_USER || 'admin',
      password: process.env.MIKROTIK_API_PASS || '',
    };
  }

  private profileForDuration(seconds: number, simultaneousDevices: number = 1): string {
    // Option C: Dedicated multi-device monetization profiles
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

  private async provisionForVoucher(voucherId: string) {
    const voucher = await this.prisma.voucher.findUniqueOrThrow({
      where: { id: voucherId },
      include: { plan: true, venue: { include: { routers: true } } },
    });

    let router: any = null;
    try {
      router = this.selectBestRouter(voucher.venue.routers, voucher.venueId);
    } catch {
      this.logger.warn(`No router for venue ${voucher.venueId} — voucher ${voucher.displayCodeEnc} stays REDEEMED for router-sync.`);
      return;
    }

    const username = voucher.displayCodeEnc || `wp_${voucher.id.slice(0, 8)}`;
    const password = voucher.displayCodeEnc || username;
    const profile = voucher.plan.rateLimit || this.profileForDuration(voucher.plan.durationSeconds, voucher.plan.simultaneousDevices);

    // Option A: Bind single-device vouchers to redeeming device MAC address
    const isSingleDevice = (voucher.plan.simultaneousDevices ?? 1) === 1;
    const isMac = voucher.redeemedMac && /^([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2})$/.test(voucher.redeemedMac);
    const macAddress = isSingleDevice && isMac ? voucher.redeemedMac!.toUpperCase() : undefined;

    try {
      await this.mikrotik.createHotspotUser(
        router.endpoint,
        this.getRouterCredentials(),
        {
          username,
          password,
          profile,
          sessionTimeoutSeconds: voucher.plan.durationSeconds,
          limitBytesTotal: voucher.plan.dataLimitBytes ? Number(voucher.plan.dataLimitBytes) : undefined,
          sharedUsers: voucher.plan.simultaneousDevices,
          macAddress,
        },
      );
      if (macAddress && typeof this.mikrotik.addIpBinding === 'function') {
        try {
          await this.mikrotik.addIpBinding(
            router.endpoint,
            this.getRouterCredentials(),
            {
              macAddress,
              type: 'bypassed',
              comment: `WP:${username}`,
            },
          );
        } catch (ipErr: any) {
          this.logger.warn(`Failed to add bypassed IP-binding for ${macAddress}: ${ipErr.message}`);
        }
      }
    } catch (err: any) {
      // Degrade, never fail the claim: the cloud voucher stays usable via
      // router-sync pull + portal code login; reconcile heals hardware later.
      this.logger.warn(`Router push failed for ${router.endpoint}: ${err.message}. Voucher ${voucher.displayCodeEnc} proceeds ACTIVE.`);
    }

    // Idempotent: a retried job must never duplicate sessions for one voucher.
    const existingVoucherSession = await this.prisma.session.findFirst({ where: { voucherId: voucher.id } });
    if (existingVoucherSession) {
      await this.prisma.voucher.updateMany({
        where: { id: voucher.id, status: { in: ['ISSUED', 'GENERATED'] } },
        data: { status: 'ACTIVE' },
      });
      this.logger.log(`Voucher ${voucher.id} already has session ${existingVoucherSession.id} — no duplicate.`);
      return;
    }

    await this.prisma.$transaction([
      this.prisma.session.create({
        data: {
          venueId: voucher.venueId,
          routerId: router.id,
          voucherId: voucher.id,
          mac: isMac ? voucher.redeemedMac!.toUpperCase() : null,
          deviceId: voucher.redeemedDeviceId || null,
          ip: voucher.redeemedIp || null,
          expiresAt: new Date(Date.now() + voucher.plan.durationSeconds * 1000),
        },
      }),
      // Only unclaimed stock flips here — first-use REDEEMED (with device
      // binding) is owned by redeem() and must survive provisioning.
      this.prisma.voucher.updateMany({
        where: { id: voucher.id, status: { in: ['ISSUED', 'GENERATED'] } },
        data: { status: 'ACTIVE' },
      }),
    ]);
  }
}
