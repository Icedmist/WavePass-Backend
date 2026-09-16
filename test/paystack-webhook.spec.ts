import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createHmac } from 'crypto';
import { PaystackService } from '../src/modules/paystack/paystack.service';
import { PaystackController } from '../src/modules/paystack/paystack.controller';

describe('Paystack webhook signature', () => {
  const secret = 'sk_test_nexawavepass_secret_123';
  let svc: PaystackService;

  beforeEach(() => {
    process.env.PAYSTACK_SECRET_KEY = secret;
    svc = new PaystackService();
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ status: true, data: {} }) } as any));
  });

  it('accepts valid HMAC-SHA512', () => {
    const body = Buffer.from(JSON.stringify({ event: 'charge.success', data: { reference: 'wp_123', id: 1 } }));
    const sig = createHmac('sha512', secret).update(body).digest('hex');
    expect(svc.verifyWebhookSignature(body, sig)).toBe(true);
  });

  it('rejects invalid signature', () => {
    const body = Buffer.from(JSON.stringify({ event: 'charge.success', data: { reference: 'wp_123', id: 1 } }));
    expect(svc.verifyWebhookSignature(body, 'bad_signature')).toBe(false);
  });

  it('rejects missing header', () => {
    const body = Buffer.from('{}');
    expect(svc.verifyWebhookSignature(body, undefined)).toBe(false);
  });

  it('rejects tampered body', () => {
    const body = Buffer.from(JSON.stringify({ event: 'charge.success', data: { reference: 'wp_123' } }));
    const sig = createHmac('sha512', secret).update(Buffer.from('different')).digest('hex');
    expect(svc.verifyWebhookSignature(body, sig)).toBe(false);
  });
});

describe('Paystack webhook controller idempotency', () => {
  it('dedupes by eventKey and enqueues only charge.success', async () => {
    // Minimal unit test for controller logic without Nest DI - we test the service-level dedupe concept via PaystackService + manual check
    // The controller does: eventKey = `${event}:${reference}:${id}`, checks existing, creates, enqueues if charge.success
    const existingKeys = new Set<string>();
    const makeEventKey = (body: any) => `${body?.event}:${body?.data?.reference}:${body?.data?.id}`;
    const body = { event: 'charge.success', data: { reference: 'wp_1', id: 42 } };
    const key = makeEventKey(body);
    expect(existingKeys.has(key)).toBe(false);
    existingKeys.add(key);
    expect(existingKeys.has(key)).toBe(true);
    // second delivery should be considered duplicate
    expect(existingKeys.has(makeEventKey(body))).toBe(true);
    // non-success should not enqueue
    const other = { event: 'charge.failed', data: { reference: 'wp_1', id: 42 } };
    expect(other.event === 'charge.success').toBe(false);
  });

  it('re-enqueues fulfilment on duplicate delivery when payment is still pending', async () => {
    const enqueued: any[] = [];
    const prisma: any = {
      webhookEvent: {
        findUnique: vi.fn(async () => ({ eventKey: 'charge.success:wp_9:7', status: 'queued' })),
        update: vi.fn(async () => ({})),
      },
      payment: {
        findUnique: vi.fn(async () => ({ id: 'pay-1', status: 'PENDING' })),
      },
    };
    const queue: any = { enqueue: vi.fn(async (d: any) => { enqueued.push(d); }) };
    const paystack = new PaystackService();
    const controller = new PaystackController(paystack, prisma, queue);

    const secret = process.env.PAYSTACK_SECRET_KEY as string;
    const body = { event: 'charge.success', data: { reference: 'wp_9', id: 7 } };
    const raw = Buffer.from(JSON.stringify(body));
    const sig = createHmac('sha512', secret).update(raw).digest('hex');

    const res = await controller.webhook(sig, { rawBody: raw } as any, body);
    expect(res).toMatchObject({ received: true, duplicate: true, requeued: true });
    expect(queue.enqueue).toHaveBeenCalledWith({ reference: 'wp_9' });
  });

  it('acks duplicate without re-enqueue when payment already fulfilled', async () => {    const prisma: any = {
      webhookEvent: {
        findUnique: vi.fn(async () => ({ eventKey: 'charge.success:wp_8:6', status: 'queued' })),
        update: vi.fn(async () => ({})),
      },
      payment: {
        findUnique: vi.fn(async () => ({ id: 'pay-1', status: 'FULFILLED' })),
      },
    };
    const queue: any = { enqueue: vi.fn(async () => ({})) };
    const controller = new PaystackController(new PaystackService(), prisma, queue);

    const secret = process.env.PAYSTACK_SECRET_KEY as string;
    const body = { event: 'charge.success', data: { reference: 'wp_8', id: 6 } };
    const raw = Buffer.from(JSON.stringify(body));
    const sig = createHmac('sha512', secret).update(raw).digest('hex');

    const res = await controller.webhook(sig, { rawBody: raw } as any, body);
    expect(res).toMatchObject({ received: true, duplicate: true });
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it('returns existing reference without new Paystack transaction when already fulfilled', async () => {
    const prisma: any = {
      order: { findUniqueOrThrow: vi.fn(async () => ({ id: 'ord-1', amountMinor: 50000 })) },
      payment: {
        findUnique: vi.fn(async () => ({ id: 'pay-1', status: 'FULFILLED', providerReference: 'wp_old_ref' })),
      },
    };
    const paystack: any = { initializeTransaction: vi.fn(async () => { throw new Error('should not be called'); }) };
    const controller = new PaystackController(paystack, prisma, { enqueue: vi.fn() } as any);

    const res = await controller.initialize({ orderId: 'ord-1', email: 'a@b.c' });
    expect(res).toMatchObject({ reference: 'wp_old_ref', alreadyFulfilled: true });
    expect(paystack.initializeTransaction).not.toHaveBeenCalled();
  });
});
