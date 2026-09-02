import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  Post,
  Req,
} from '@nestjs/common';
import { FastifyRequest } from 'fastify';
import { PaystackService } from './paystack.service';
import { PrismaService } from '../../common/prisma.service';
import { PaymentFulfilmentQueue } from '../jobs/payment-fulfilment.queue';

@Controller('payments/paystack')
export class PaystackController {
  constructor(
    private readonly paystack: PaystackService,
    private readonly prisma: PrismaService,
    private readonly fulfilmentQueue: PaymentFulfilmentQueue,
  ) {}

  @Post('initialize')
  async initialize(@Body() body: { orderId: string; email: string }) {
    const order = await this.prisma.order.findUniqueOrThrow({ where: { id: body.orderId } });

    const reference = `wp_${order.id}_${Date.now()}`;
    const init = await this.paystack.initializeTransaction({
      amountMinor: order.amountMinor, // locked server-side amount — never trust the client
      email: body.email,
      reference,
      metadata: { orderId: order.id, venueId: order.venueId, planId: order.planId },
    });

    await this.prisma.payment.create({
      data: {
        orderId: order.id,
        providerReference: reference,
        amountMinor: order.amountMinor,
        status: 'PENDING',
      },
    });

    // Only the public checkout URL/access code goes to the client.
    return { authorizationUrl: (init as any).data.authorization_url, reference };
  }

  /**
   * Webhook is the primary fulfilment trigger. It must:
   *  1. Verify the HMAC signature over the *raw* body before trusting anything.
   *  2. Persist the event under a unique event key (idempotency).
   *  3. ACK fast (200) and hand real work to the queue — never block here.
   */
  @Post('webhook')
  @HttpCode(200)
  async webhook(
    @Headers('x-paystack-signature') signature: string,
    @Req() req: FastifyRequest & { rawBody?: Buffer },
    @Body() body: any,
  ) {
    const rawBody = req.rawBody ?? Buffer.from(JSON.stringify(body));
    const signatureValid = this.paystack.verifyWebhookSignature(rawBody, signature);
    if (!signatureValid) {
      throw new BadRequestException('Invalid signature');
    }

    const eventKey = `${body?.event}:${body?.data?.reference}:${body?.data?.id}`;

    const existing = await this.prisma.webhookEvent.findUnique({ where: { eventKey } });
    if (existing) {
      // Duplicate delivery — ack and stop. No double fulfilment.
      return { received: true, duplicate: true };
    }

    await this.prisma.webhookEvent.create({
      data: {
        eventKey,
        signatureValid,
        payloadJson: body,
        status: 'queued',
      },
    });

    if (body?.event === 'charge.success') {
      await this.fulfilmentQueue.enqueue({ reference: body.data.reference });
    }

    return { received: true };
  }
}
