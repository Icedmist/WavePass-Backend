import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';
import { PaymentFulfilmentProcessor } from '../jobs/payment-fulfilment.processor';
import { PaymentFulfilmentQueue } from '../jobs/payment-fulfilment.queue';
import { PaystackService } from '../paystack/paystack.service';

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly fulfilmentProcessor?: PaymentFulfilmentProcessor,
    private readonly fulfilmentQueue?: PaymentFulfilmentQueue,
    private readonly paystack?: PaystackService,
  ) {}

  /** The order locks the plan's *current* price/duration at creation time — later
   *  price changes never retroactively affect it (PRD §4.2, §23). */
  async create(params: { venueId: string; planId: string; customerRef?: string }) {
    const plan = await this.prisma.plan.findUniqueOrThrow({ where: { id: params.planId } });

    return this.prisma.order.create({
      data: {
        venueId: params.venueId,
        planId: plan.id,
        customerRef: params.customerRef,
        amountMinor: plan.priceMinor,
        status: 'AWAITING_PAYMENT',
      },
    });
  }

  async status(orderId: string) {
    let order = await this.prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      include: { payment: true },
    });

    // Fallback fulfilment trigger: if order is still awaiting payment / pending,
    // re-verify with Paystack so that missing/dropped webhooks don't leave the order
    // sitting PENDING forever while the customer already paid.
    if (
      order.payment?.providerReference &&
      (order.status === 'AWAITING_PAYMENT' || order.status === 'CREATED' || order.payment.status === 'PENDING')
    ) {
      try {
        if (this.fulfilmentProcessor) {
          await this.fulfilmentProcessor.fulfill(order.payment.providerReference);
          order = await this.prisma.order.findUniqueOrThrow({
            where: { id: orderId },
            include: { payment: true },
          });
        } else if (this.fulfilmentQueue) {
          await this.fulfilmentQueue.enqueue({ reference: order.payment.providerReference });
        }
      } catch (err: any) {
        this.logger.warn(`Order ${orderId} fallback re-verification error: ${err.message}`);
      }
    }

    return order;
  }
}
