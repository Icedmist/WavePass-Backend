import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { PrismaService } from '../../common/prisma.service';
import { MikrotikAdapter } from './mikrotik.adapter';

@Processor('mikrotik-provisioning')
export class MikrotikProvisioningProcessor extends WorkerHost {
  private readonly logger = new Logger(MikrotikProvisioningProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mikrotik: MikrotikAdapter,
  ) {
    super();
  }

  async process(job: Job<{ orderId?: string; voucherId?: string }>) {
    const { orderId, voucherId } = job.data;

    if (orderId) return this.provisionForOrder(orderId);
    if (voucherId) return this.provisionForVoucher(voucherId);
  }

  private async provisionForOrder(orderId: string) {
    const order = await this.prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      include: { plan: true, venue: { include: { routers: true } } },
    });

    // MVP: pick the venue's first enabled router. Multi-router selection is P1.
    const router = order.venue.routers[0];
    if (!router) {
      this.logger.error(`No router registered for venue ${order.venueId}; retrying`);
      throw new Error('No router available'); // triggers BullMQ retry/backoff
    }

    const isMac = order.customerRef && /^([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2})$/.test(order.customerRef);
    const username = isMac ? order.customerRef!.toUpperCase() : `wp_${randomBytes(4).toString('hex')}`;
    const password = isMac ? username : randomBytes(6).toString('hex');
    const profile = order.plan.rateLimit || `profile_${this.formatDuration(order.plan.durationSeconds)}`;

    await this.mikrotik.createHotspotUser(
      router.endpoint,
      { username: process.env.MIKROTIK_API_USER as string, password: process.env.MIKROTIK_API_PASS as string },
      {
        username,
        password,
        profile,
        sessionTimeoutSeconds: order.plan.durationSeconds,
        limitBytesTotal: order.plan.dataLimitBytes ? Number(order.plan.dataLimitBytes) : undefined,
        sharedUsers: order.plan.simultaneousDevices,
      },
    );

    await this.prisma.$transaction([
      this.prisma.session.create({
        data: {
          venueId: order.venueId,
          routerId: router.id,
          orderId: order.id,
          mac: isMac ? username : null,
          deviceId: isMac ? username : null,
          expiresAt: new Date(Date.now() + order.plan.durationSeconds * 1000),
        },
      }),
      this.prisma.order.update({ where: { id: order.id }, data: { status: 'ACTIVE' } }),
    ]);
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

    const router = voucher.venue.routers[0];
    if (!router) throw new Error('No router available');

    const username = `wp_${randomBytes(4).toString('hex')}`;
    const password = randomBytes(6).toString('hex');

    await this.mikrotik.createHotspotUser(
      router.endpoint,
      { username: process.env.MIKROTIK_API_USER as string, password: process.env.MIKROTIK_API_PASS as string },
      {
        username,
        password,
        sessionTimeoutSeconds: voucher.plan.durationSeconds,
        limitBytesTotal: voucher.plan.dataLimitBytes ? Number(voucher.plan.dataLimitBytes) : undefined,
        sharedUsers: voucher.plan.simultaneousDevices,
      },
    );

    await this.prisma.$transaction([
      this.prisma.session.create({
        data: {
          venueId: voucher.venueId,
          routerId: router.id,
          voucherId: voucher.id,
          expiresAt: new Date(Date.now() + voucher.plan.durationSeconds * 1000),
        },
      }),
      this.prisma.voucher.update({ where: { id: voucher.id }, data: { status: 'ACTIVE' } }),
    ]);
  }
}
