import { describe, it, expect, vi } from 'vitest';
import { PortalService } from '../src/modules/portal/portal.service';
import { MikrotikProvisioningProcessor } from '../src/modules/mikrotik/mikrotik-provisioning.processor';
import { NotificationsService } from '../src/modules/notifications/notifications.service';

/**
 * Vertical slice proof: a guest transfer payment MUST end in usable access.
 * submitTransferRequest -> approveAccess -> provisionForOrder ->
 * retrieveVoucher/getLandingStatus. The router credentials pushed MUST equal
 * the voucher code the guest receives (previously the router got the MAC
 * while every guest surface used the code, so paid guests were rejected).
 */
function mockDb() {
  const orders = new Map<string, any>();
  const payments = new Map<string, any>();
  const vouchers = new Map<string, any>();
  const sessions: any[] = [];
  const notifications: any[] = [];
  let n = 0;
  const id = (p: string) => `${p}-${++n}`;
  const match = (row: any, where: any): boolean => {
    for (const [k, v] of Object.entries(where || {})) {
      if (v !== undefined && v !== null && typeof v !== 'object') {
        if (row[k] !== v) return false;
      } else if (v && typeof v === 'object' && 'in' in (v as any)) {
        if (!(v as any).in.includes(row[k])) return false;
      }
    }
    return true;
  };
  const prisma: any = {
    order: {
      create: vi.fn(async ({ data }: any) => {
        const row = { id: id('order'), status: 'CREATED', createdAt: new Date(), ...data };
        orders.set(row.id, row);
        return row;
      }),
      findUniqueOrThrow: vi.fn(async ({ where }: any) => {
        const row = orders.get(where.id);
        if (!row) throw new Error('Not found');
        return { ...row, plan: row._plan, venue: row._venue };
      }),
      findUnique: vi.fn(async ({ where }: any) => {
        const row = orders.get(where.id);
        if (!row) return null;
        return { ...row, plan: row._plan, venue: row._venue };
      }),
      findFirst: vi.fn(async ({ where }: any) => {
        const rows = [...orders.values()].filter((r) => match(r, where));
        const row = rows[rows.length - 1] || null;
        return row ? { ...row, plan: row._plan, venue: row._venue } : null;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const row = { ...orders.get(where.id), ...data };
        orders.set(where.id, row);
        return row;
      }),
    },
    payment: {
      create: vi.fn(async ({ data }: any) => {
        const row = { id: id('pay'), status: 'PENDING', createdAt: new Date(), ...data };
        payments.set(row.id, row);
        return row;
      }),
      findUnique: vi.fn(async ({ where }: any) => {
        if (where.orderId) return [...payments.values()].find((p) => p.orderId === where.orderId) || null;
        return null;
      }),
    },
    voucher: {
      create: vi.fn(async ({ data }: any) => {
        const row = { id: id('v'), ...data };
        vouchers.set(row.id, row);
        return row;
      }),
      findFirst: vi.fn(async ({ where }: any) => {
        const rows = [...vouchers.values()].filter((r) => match(r, where));
        const row = rows[rows.length - 1] || null;
        return row ? { ...row, plan: row._plan, venue: row._venue } : null;
      }),
      findMany: vi.fn(async ({ where }: any) => {
        const rows = [...vouchers.values()].filter((r) => match(r, where));
        return rows.map((r) => ({ ...r, plan: r._plan, venue: r._venue }));
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const row = { ...vouchers.get(where.id), ...data };
        vouchers.set(where.id, row);
        return row;
      }),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    session: {
      create: vi.fn(async ({ data }: any) => {
        const row = { id: id('sess'), status: 'ACTIVE', startedAt: new Date(), ...data };
        sessions.push(row);
        return row;
      }),
      findFirst: vi.fn(async ({ where }: any) => {
        const rows = sessions.filter((r) => match(r, where));
        const row = rows[rows.length - 1] || null;
        if (!row) return null;
        const v = row.voucherId ? vouchers.get(row.voucherId) : null;
        return {
          ...row,
          voucher: v ? { ...v, plan: v._plan } : null,
          router: null,
        };
      }),
    },
    router: { findFirst: vi.fn(async () => null) },
    notification: {
      create: vi.fn(async ({ data }: any) => {
        const row = { id: id('notif'), read: false, createdAt: new Date(), ...data };
        notifications.push(row);
        return row;
      }),
      findFirst: vi.fn(async () => null),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    $transaction: vi.fn(async (ops: any) => ops),
  };
  return { prisma, orders, payments, vouchers, sessions, notifications };
}

describe('Transfer money -> granted access (vertical slice)', () => {
  it('guest transfer ends with router credentials equal to the presented code', async () => {
    const { prisma, orders, sessions } = mockDb();
    const plan = { id: 'plan-1', name: '1 Hour', priceMinor: 50000, durationSeconds: 3600, simultaneousDevices: 1, rateLimit: null };
    const venue = { id: 'venue-1', name: 'Cafe', slug: 'cafe', routers: [{ id: 'r1', endpoint: 'http://192.168.88.1', status: 'ONLINE' }] };
    const plans: any = {
      getPlanById: vi.fn(async () => plan),
      listPlans: vi.fn(async () => [plan]),
    };
    const venues: any = {
      getVenueBySlug: vi.fn(async () => venue),
      getVenueById: vi.fn(async () => venue),
      getDefaultVenue: vi.fn(async () => venue),
    };
    const enqueued: any[] = [];
    const queue: any = { enqueue: vi.fn(async (d: any) => { enqueued.push(d); }) };
    const paystack: any = { isMock: () => false };
    const portal = new PortalService(prisma, paystack, plans, venues, queue);

    const pushed: any[] = [];
    const adapter: any = { createHotspotUser: vi.fn(async (...args: any[]) => { pushed.push(args); }) };
    const notifications = new NotificationsService(prisma);
    const provisioning = new MikrotikProvisioningProcessor(prisma, adapter, notifications);

    // Attach plan/venue to created rows for later includes
    const origOrderCreate = prisma.order.create;
    prisma.order.create = vi.fn(async ({ data }: any) => {
      const row = await origOrderCreate({ data });
      row._plan = plan;
      row._venue = venue;
      return row;
    });

    // 1. Guest submits bank transfer
    const mac = 'AA:BB:CC:DD:EE:FF';
    const submitted: any = await portal.submitTransferRequest({
      venueSlug: 'cafe', mac, planId: 'plan-1', senderName: 'Tunde',
    } as any);
    expect(submitted.ok).toBe(true);
    const orderId = submitted.orderId;

    // 2. Owner approves
    const approved: any = await portal.approveAccess({ venueId: 'venue-1', orderId, mac });
    expect(approved.ok).toBe(true);
    expect(approved.voucherCode).toMatch(/^\d{6}$/);
    expect(enqueued.length).toBe(1);

    // 3. Provisioning runs (queue worker)
    await (provisioning as any).provisionForOrder(orderId);
    expect(pushed.length).toBe(1);
    // THE guarantee: router credentials == presented voucher code
    expect(pushed[0][2].username).toBe(approved.voucherCode);
    expect(pushed[0][2].password).toBe(approved.voucherCode);
    // Single-device MAC still bound at router level
    expect(pushed[0][2].macAddress).toBe(mac);

    // 4. Order ACTIVE + session bound to device MAC
    expect(orders.get(orderId).status).toBe('ACTIVE');
    expect(sessions.length).toBe(1);
    expect(sessions[0].mac).toBe(mac);

    // 5. Guest retrieves the code by MAC (portal polling)
    const retrieved: any = await portal.retrieveVoucher({ mac, venueId: 'venue-1' });
    expect(retrieved.found).toBe(true);
    expect(retrieved.voucherCode).toBe(approved.voucherCode);

    // 6. Landing status shows paid access with the same credentials
    const landing: any = await portal.getLandingStatus(mac);
    expect(landing.hasPaid).toBe(true);
    expect(landing.username).toBe(approved.voucherCode);
    expect(landing.password).toBe(approved.voucherCode);
  });
});
