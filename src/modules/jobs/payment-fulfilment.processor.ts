import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';
import { PaystackService } from '../paystack/paystack.service';
import { MikrotikProvisioningQueue } from '../mikrotik/mikrotik-provisioning.queue';

@Processor('payment-fulfilment')
export class PaymentFulfilmentProcessor extends WorkerHost {
  private readonly logger = new Logger(PaymentFulfilmentProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly paystack: PaystackService,
    private readonly provisioningQueue: MikrotikProvisioningQueue,
  ) {
    super();
  }

  async process(job: Job<{ reference: string }>) {
    const { reference } = job.data;

    // 1. Never trust the webhook payload alone — re-verify server-to-server.
    const verified = await this.paystack.verifyTransaction(reference);
    if (verified.data.status !== 'success') {
      this.logger.warn(`Reference ${reference} not successful: ${verified.data.status}`);
      return;
    }

    const payment = await this.prisma.payment.findUnique({
      where: { providerReference: reference },
      include: { order: true },
    });
    if (!payment) {
      this.logger.error(`No local payment for reference ${reference}`);
      return;
    }

    // 2. Amount must match the server-locked order amount, not whatever Paystack "helpfully" echoes.
    if (verified.data.amount !== payment.order.amountMinor) {
      this.logger.error(`Amount mismatch on ${reference}: paid ${verified.data.amount}, expected ${payment.order.amountMinor}`);
      await this.prisma.order.update({
        where: { id: payment.orderId },
        data: { status: 'REFUND_REQUIRED' },
      });
      return;
    }

    // 3. Atomic, exactly-once fulfilment. A payment already FULFILLED short-circuits here.
    const fulfilled = await this.prisma.$transaction(async (tx) => {
      const current = await tx.payment.findUnique({ where: { id: payment.id } });
      if (current?.status === 'FULFILLED') return null; // already done — duplicate webhook/retry

      await tx.payment.update({
        where: { id: payment.id },
        data: { status: 'FULFILLED', paidAt: new Date(), providerTransactionId: String(verified.data.id) },
      });
      return tx.order.update({
        where: { id: payment.orderId },
        data: { status: 'PROVISIONING' },
      });
    });

    if (!fulfilled) return;

    // 4. Hand off to router provisioning — this step is allowed to fail/retry independently.
    await this.provisioningQueue.enqueue({ orderId: payment.orderId });
  }
}
