import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';

@Injectable()
export class OrdersService {
  constructor(private readonly prisma: PrismaService) {}

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
    return this.prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      include: { payment: true },
    });
  }
}
