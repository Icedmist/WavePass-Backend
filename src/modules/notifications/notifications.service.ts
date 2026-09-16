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
