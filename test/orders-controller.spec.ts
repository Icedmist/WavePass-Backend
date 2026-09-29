import { describe, it, expect, vi } from 'vitest';
import { OrdersController } from '../src/modules/orders/orders.controller';
import { OrdersService } from '../src/modules/orders/orders.service';

describe('OrdersController & OrdersService.create unit tests', () => {
  it('OrdersController delegates create and status to OrdersService', async () => {
    const mockOrdersService: any = {
      create: vi.fn(async (params: any) => ({ id: 'ord-1', ...params })),
      status: vi.fn(async (id: string) => ({ id, status: 'AWAITING_PAYMENT' })),
    };
    const controller = new OrdersController(mockOrdersService);

    const created = await controller.create({ venueId: 'v-1', planId: 'p-1', customerRef: 'cust-1' });
    expect(mockOrdersService.create).toHaveBeenCalledWith({ venueId: 'v-1', planId: 'p-1', customerRef: 'cust-1' });
    expect(created.id).toBe('ord-1');

    const status = await controller.status('ord-1');
    expect(mockOrdersService.status).toHaveBeenCalledWith('ord-1');
    expect(status.status).toBe('AWAITING_PAYMENT');
  });

  it('OrdersService.create locks plan price at order creation time', async () => {
    const prisma: any = {
      plan: {
        findUniqueOrThrow: vi.fn(async () => ({ id: 'plan-100', priceMinor: 25000 })),
      },
      order: {
        create: vi.fn(async ({ data }: any) => ({ id: 'ord-new', ...data })),
      },
    };
    const svc = new OrdersService(prisma);
    const order = await svc.create({ venueId: 'venue-1', planId: 'plan-100', customerRef: 'cust-abc' });

    expect(prisma.plan.findUniqueOrThrow).toHaveBeenCalledWith({ where: { id: 'plan-100' } });
    expect(order.amountMinor).toBe(25000);
    expect(order.status).toBe('AWAITING_PAYMENT');
    expect(order.venueId).toBe('venue-1');
    expect(order.customerRef).toBe('cust-abc');
  });
});
