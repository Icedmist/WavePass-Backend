import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger } from '@nestjs/common';
import { createHash, randomInt } from 'crypto';
import { PrismaService } from '../../common/prisma.service';
import { PaystackService } from '../paystack/paystack.service';
import { MikrotikProvisioningQueue } from '../mikrotik/mikrotik-provisioning.queue';
import { NotificationsService } from '../notifications/notifications.service';

@Processor('payment-fulfilment')
export class PaymentFulfilmentProcessor extends WorkerHost {
  private readonly logger = new Logger(PaymentFulfilmentProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly paystack: PaystackService,
    private readonly provisioningQueue: MikrotikProvisioningQueue,
    private readonly notifications: NotificationsService,
  ) {
    super();
  }

  async process(job: Job<{ reference: string }>) {
    await this.fulfill(job.data.reference);
  }

  /**
   * Core idempotent fulfilment logic. Can be invoked directly as fallback
   * or via BullMQ worker.
   */
  async fulfill(reference: string) {
    // 1. Never trust the webhook payload alone — re-verify server-to-server.
    const verified = await this.paystack.verifyTransaction(reference);
    if (verified.data.status !== 'success') {
      this.logger.warn(`Reference ${reference} not successful: ${verified.data.status}`);
      return null;
    }

    const payment = await this.prisma.payment.findUnique({
      where: { providerReference: reference },
      include: { order: true },
    });
    if (!payment) {
      this.logger.error(`No local payment for reference ${reference}`);
      return null;
    }

    // 2. Amount guard: prevent underpayment. If customer paid at least the locked order amount, allow fulfilment.
    if (verified.data.amount < payment.order.amountMinor) {
      this.logger.error(
        `Amount underpayment on ${reference}: paid ${verified.data.amount}, expected ${payment.order.amountMinor}`,
      );
      await this.prisma.order.update({
        where: { id: payment.orderId },
        data: { status: 'REFUND_REQUIRED' },
      });
      try {
        await this.notifications.create({
          venueId: payment.order.venueId,
          type: 'PAYMENT',
          title: 'Payment underpayment — refund required',
          body: `Order ${payment.orderId} (${reference}) received ₦${(verified.data.amount / 100).toFixed(2)}, expected ₦${(payment.order.amountMinor / 100).toFixed(2)}. Marked REFUND_REQUIRED.`,
          amountMinor: verified.data.amount,
          reference,
        });
      } catch (err: any) {
        this.logger.warn(`Failed to dispatch underpayment notification: ${err.message}`);
      }
      return null;
    }

    // 3. Atomic, exactly-once fulfilment. A payment already FULFILLED short-circuits here.
    const fulfilled = await this.prisma.$transaction(async (tx) => {
      const current = await tx.payment.findUnique({ where: { id: payment.id } });
      if (current?.status === 'FULFILLED') return null; // already done — duplicate webhook/retry

      await tx.payment.update({
        where: { id: payment.id },
        data: { status: 'FULFILLED', paidAt: new Date(), providerTransactionId: String(verified.data.id) },
      });

      const order = await tx.order.findUniqueOrThrow({
        where: { id: payment.orderId },
        include: { plan: true },
      });

      // Generate a clean 6-digit numeric voucher code (retry on hash collision)
      const isMac = order.customerRef && /^([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2})$/.test(order.customerRef);
      const expiresAt = new Date(Date.now() + order.plan.durationSeconds * 1000);

      // Create or ensure Voucher exists
      let created = false;
      for (let attempt = 0; attempt < 5 && !created; attempt++) {
        const voucherCode = String(randomInt(100000, 1000000));
        const codeHash = createHash('sha256').update(voucherCode).digest('hex');
        try {
          await tx.voucher.create({
            data: {
              venueId: order.venueId,
              planId: order.planId,
              paymentId: payment.id,
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
          created = true;
        } catch (err: any) {
          if (err.code === 'P2002' && attempt < 4) continue;
          throw err;
        }
      }

      return tx.order.update({
        where: { id: payment.orderId },
        data: { status: 'PROVISIONING' },
      });
    });

    if (!fulfilled) return null;

    // Venue-owner notification (notification bar source) — best effort, never blocks fulfilment.
    try {
      const full = await this.prisma.order.findUnique({
        where: { id: payment.orderId },
        include: { plan: true },
      });
      if (full) {
        await this.notifications.paymentReceived(
          full.venueId,
          full.amountMinor,
          reference,
          full.plan?.name,
        );
      }
    } catch (err: any) {
      this.logger.warn(`Payment notification skipped for ${reference}: ${err.message}`);
    }

    // 4. Hand off to router provisioning — this step is allowed to fail/retry independently.
    try {
      await this.provisioningQueue.enqueue({ orderId: payment.orderId });
    } catch (err: any) {
      this.logger.warn(`Provisioning enqueue failed for order ${payment.orderId}: ${err.message}. Voucher is already ACTIVE for router-sync.`);
    }

    return fulfilled;
  }
}
