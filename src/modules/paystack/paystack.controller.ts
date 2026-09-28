import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  Logger,
  Post,
  Req,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { FastifyRequest } from 'fastify';
import { PaystackService } from './paystack.service';
import { PrismaService } from '../../common/prisma.service';
import { PaymentFulfilmentQueue } from '../jobs/payment-fulfilment.queue';
import { AdminService } from '../admin/admin.service';
import { CashoutsService } from '../cashouts/cashouts.service';

const REVERSAL_EVENTS = new Set([
  'refund.pending',
  'refund.processed',
  'refund.failed',
  'charge.dispute.create',
  'charge.dispute.remind',
  'charge.dispute.resolve',
]);

const TRANSFER_EVENTS = new Set([
  'transfer.success',
  'transfer.failed',
  'transfer.reversed',
]);

@Controller('payments/paystack')
export class PaystackController {
  private readonly logger = new Logger(PaystackController.name);

  constructor(
    private readonly paystack: PaystackService,
    private readonly prisma: PrismaService,
    private readonly fulfilmentQueue: PaymentFulfilmentQueue,
    private readonly admin?: AdminService,
    private readonly cashouts?: CashoutsService,
  ) {}

  @Throttle({ strict: { ttl: 60000, limit: 10 } })
  @Post('initialize')
  async initialize(@Body() body: { orderId: string; email: string }) {
    const order = await this.prisma.order.findUniqueOrThrow({ where: { id: body.orderId } });

    // Already paid: hand back the fulfilled reference instead of opening a
    // second Paystack transaction that would strand with no local row.
    const existing = await this.prisma.payment.findUnique({ where: { orderId: order.id } });
    if (existing && existing.status === 'FULFILLED') {
      return { authorizationUrl: null, reference: existing.providerReference, alreadyFulfilled: true };
    }

    const reference = `wp_${order.id}_${Date.now()}`;
    const init = await this.paystack.initializeTransaction({
      amountMinor: order.amountMinor, // locked server-side amount — never trust the client
      email: body.email,
      reference,
      metadata: { orderId: order.id, venueId: order.venueId, planId: order.planId },
    });

    // Idempotent re-init: a second initialize for the same order refreshes the
    // PENDING payment row instead of crashing on the unique orderId (P2002).
    if (existing) {
      await this.prisma.payment.update({
        where: { id: existing.id },
        data: { providerReference: reference, amountMinor: order.amountMinor, status: 'PENDING' },
      });
    } else {
      await this.prisma.payment.create({
        data: {
          orderId: order.id,
          providerReference: reference,
          amountMinor: order.amountMinor,
          status: 'PENDING',
        },
      });
    }

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
      const eventKey = `invalid_sig:${body?.event || 'unknown'}:${body?.data?.reference || Date.now()}:${Math.random().toString(36).slice(2, 7)}`;
      try {
        if (this.prisma?.webhookEvent?.create) {
          await this.prisma.webhookEvent.create({
            data: {
              eventKey,
              signatureValid: false,
              payloadJson: body || {},
              status: 'invalid_signature',
            },
          }).catch(() => {});
        }
      } catch {}
      this.logger.warn(
        `Paystack webhook signature verification failed for event: ${body?.event}, ref: ${body?.data?.reference}. Recorded trace under ${eventKey}.`,
      );
      throw new BadRequestException('Invalid signature');
    }

    const eventKey = `${body?.event}:${body?.data?.reference}:${body?.data?.id}`;

    const existing = await this.prisma.webhookEvent.findUnique({ where: { eventKey } });
    if (existing) {
      // Duplicate delivery — but if fulfilment never ran (e.g. Redis was down
      // when the first delivery arrived and enqueue threw), re-enqueue now.
      // jobId = reference makes this a safe no-op when already queued/done.
      if (body?.event === 'charge.success' && body?.data?.reference) {
        const payment = await this.prisma.payment.findUnique({
          where: { providerReference: body.data.reference },
        });
        if (payment && payment.status !== 'FULFILLED') {
          await this.fulfilmentQueue.enqueue({ reference: body.data.reference });
          await this.prisma.webhookEvent.update({
            where: { eventKey },
            data: { status: 'requeued' },
          });
          return { received: true, duplicate: true, requeued: true };
        }
      }
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

    // Reversals (refunds, disputes): revoke unused access, flag consumed ones.
    if (body?.event && REVERSAL_EVENTS.has(body.event)) {
      const result = await this.admin?.handlePaymentReversal(body.event, body.data || {});
      return { received: true, reversal: result || { ok: false, error: 'admin unavailable' } };
    }

    // Transfer lifecycle: finalize owner cashouts (success/failed/reversed).
    if (body?.event && TRANSFER_EVENTS.has(body.event)) {
      const code = body?.data?.transfer_code;
      const status = body?.data?.status || body.event.split('.')[1];
      if (!code) return { received: true, transfer: { ok: false, error: 'no transfer code' } };
      const result = await this.cashouts?.finalizeTransferEvent(code, status);
      return { received: true, transfer: result || { ok: false, error: 'cashouts unavailable' } };
    }

    return { received: true };
  }
}
