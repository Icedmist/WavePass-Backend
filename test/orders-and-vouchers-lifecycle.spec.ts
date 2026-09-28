import { describe, it, expect, vi } from 'vitest';
import { OrdersService } from '../src/modules/orders/orders.service';
import { VouchersService } from '../src/modules/vouchers/vouchers.service';
import { PaymentFulfilmentProcessor } from '../src/modules/jobs/payment-fulfilment.processor';

describe('Orders fallback fulfilment & Vouchers lazy sweep', () => {
  it('OrdersService.status triggers fallback re-verification when order is pending', async () => {
    let orderState = {
      id: 'ord-123',
      venueId: 'venue-1',
      planId: 'plan-1',
      status: 'AWAITING_PAYMENT',
      payment: {
        id: 'pay-123',
        status: 'PENDING',
        providerReference: 'ref-123',
      },
    };

    const prisma: any = {
      order: {
        findUniqueOrThrow: vi.fn(async () => ({ ...orderState })),
      },
    };

    const mockProcessor: any = {
      fulfill: vi.fn(async (ref: string) => {
        orderState = {
          ...orderState,
          status: 'PROVISIONING',
          payment: { ...orderState.payment, status: 'FULFILLED' },
        };
        return orderState;
      }),
    };

    const ordersService = new OrdersService(prisma, mockProcessor);
    const result = await ordersService.status('ord-123');

    expect(mockProcessor.fulfill).toHaveBeenCalledWith('ref-123');
    expect(result.status).toBe('PROVISIONING');
    expect(result.payment?.status).toBe('FULFILLED');
  });

  it('PaymentFulfilmentProcessor.fulfill accepts exact or overpaid amounts, but rejects underpayment', async () => {
    const notifications: any = {
      create: vi.fn(async () => ({})),
      paymentReceived: vi.fn(async () => ({})),
    };
    const provisioningQueue: any = {
      enqueue: vi.fn(async () => ({})),
    };

    let orderStatus = 'AWAITING_PAYMENT';
    const prisma: any = {
      payment: {
        findUnique: vi.fn(async () => ({
          id: 'pay-1',
          orderId: 'ord-1',
          providerReference: 'ref-underpay',
          status: 'PENDING',
          order: { id: 'ord-1', venueId: 'venue-1', amountMinor: 50000 },
        })),
        update: vi.fn(),
      },
      order: {
        update: vi.fn(async ({ data }: any) => {
          orderStatus = data.status;
          return { id: 'ord-1', status: orderStatus };
        }),
      },
      $transaction: vi.fn(),
    };

    const paystack: any = {
      verifyTransaction: vi.fn(async () => ({
        status: true,
        data: { status: 'success', id: 999, amount: 40000 }, // paid 40k, expected 50k
      })),
    };

    const processor = new PaymentFulfilmentProcessor(prisma, paystack, provisioningQueue, notifications);
    const result = await processor.fulfill('ref-underpay');

    expect(result).toBeNull();
    expect(orderStatus).toBe('REFUND_REQUIRED');
    expect(notifications.create).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'PAYMENT',
        title: expect.stringContaining('refund required'),
      }),
    );
  });

  it('VouchersService.sweepExpiredVouchers flips past-due ISSUED vouchers to EXPIRED', async () => {
    let swept = false;
    const prisma: any = {
      voucher: {
        updateMany: vi.fn(async ({ where, data }: any) => {
          if (where.status?.in?.includes('ISSUED') && data.status === 'EXPIRED') {
            swept = true;
          }
          return { count: 3 };
        }),
        findUnique: vi.fn(async () => ({
          id: 'v-1',
          displayCodeEnc: 'TEST-CODE',
          status: 'EXPIRED',
          expiresAt: new Date(Date.now() - 3600000),
        })),
      },
    };

    const vouchersService = new VouchersService(prisma, {} as any);
    const res = await vouchersService.check('TEST-CODE');

    expect(swept).toBe(true);
    expect(prisma.voucher.updateMany).toHaveBeenCalledWith({
      where: {
        expiresAt: { lt: expect.any(Date) },
        status: { in: ['ISSUED', 'GENERATED'] },
      },
      data: { status: 'EXPIRED' },
    });
    expect(res.status).toBe('EXPIRED');
  });
});
