import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Best-effort create — swallows errors if table not yet migrated. */
  async create(data: {
    venueId: string;
    type?: 'PAYMENT' | 'VOUCHER' | 'SYSTEM';
    title: string;
    body: string;
    amountMinor?: number;
    reference?: string;
  }) {
    try {
      const db = this.prisma as any;
      if (!db.notification) return null;
      return await db.notification.create({ data });
    } catch (err: any) {
      this.logger.warn(`Notification create skipped: ${err.message}`);
      return null;
    }
  }

  async paymentReceived(venueId: string, amountMinor: number, reference: string, planName?: string) {
    const ngn = (amountMinor / 100).toLocaleString('en-NG', { style: 'currency', currency: 'NGN' });
    return this.create({
      venueId,
      type: 'PAYMENT',
      title: `Payment received — ${ngn}`,
      body: `${planName || 'Wi-Fi pass'} paid (${reference}). Voucher is active for the guest.`,
      amountMinor,
      reference,
    });
  }

  /**
   * Best-effort alert, deduplicated: skips when an unread notification with
   * the same reference already exists (retried jobs must not spam owners).
   */
  async notifyOnce(data: {
    venueId: string;
    type?: 'PAYMENT' | 'VOUCHER' | 'SYSTEM';
    title: string;
    body: string;
    amountMinor?: number;
    reference?: string;
  }) {
    try {
      const db = this.prisma as any;
      if (!db.notification) return null;
      if (data.reference) {
        const dupe = await db.notification.findFirst({
          where: { venueId: data.venueId, reference: data.reference, read: false },
          select: { id: true },
        });
        if (dupe) return null;
      }
      return await db.notification.create({ data });
    } catch (err: any) {
      this.logger.warn(`Notification notifyOnce skipped: ${err.message}`);
      return null;
    }
  }

  async provisioningDelayed(venueId: string, orderId: string, detail: string) {
    return this.notifyOnce({
      venueId,
      type: 'SYSTEM',
      title: 'Provisioning delayed — router sync required',
      body: `Order ${orderId} is paid and usable via cloud voucher, but the router push failed (${detail}). The router will pick it up via router-sync; reconcile if it persists.`,
      reference: `PROVISIONING:${orderId}`,
    });
  }

  async listByVenue(venueId: string, unreadOnly = false) {
    try {
      const db = this.prisma as any;
      if (!db.notification) return [];
      return await db.notification.findMany({
        where: { venueId, ...(unreadOnly ? { read: false } : {}) },
        orderBy: { createdAt: 'desc' },
        take: 100,
      });
    } catch {
      return [];
    }
  }

  async markRead(id: string) {
    const db = this.prisma as any;
    return db.notification.update({ where: { id }, data: { read: true } });
  }

  async markAllRead(venueId: string) {
    const db = this.prisma as any;
    return db.notification.updateMany({ where: { venueId, read: false }, data: { read: true } });
  }
}
