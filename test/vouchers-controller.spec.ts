import { describe, it, expect, vi } from 'vitest';
import { VouchersController } from '../src/modules/vouchers/vouchers.controller';

describe('VouchersController unit tests', () => {
  it('delegates list to vouchers.listByVenue with venueId or empty string', async () => {
    const mockVouchersService: any = {
      listByVenue: vi.fn(async (venueId: string) => [{ id: 'v-1', venueId }]),
    };
    const controller = new VouchersController(mockVouchersService);

    const resWithVenue = await controller.list('venue-123');
    expect(mockVouchersService.listByVenue).toHaveBeenCalledWith('venue-123');
    expect(resWithVenue).toEqual([{ id: 'v-1', venueId: 'venue-123' }]);

    const resWithoutVenue = await controller.list(undefined);
    expect(mockVouchersService.listByVenue).toHaveBeenCalledWith('');
    expect(resWithoutVenue).toEqual([{ id: 'v-1', venueId: '' }]);
  });

  it('delegates check to vouchers.check', async () => {
    const mockVouchersService: any = {
      check: vi.fn(async (code: string) => ({ exists: true, code })),
    };
    const controller = new VouchersController(mockVouchersService);

    const res = await controller.check('ABC-123');
    expect(mockVouchersService.check).toHaveBeenCalledWith('ABC-123');
    expect(res).toEqual({ exists: true, code: 'ABC-123' });
  });

  it('delegates generateBatch and parses expiresAt string to Date if provided', async () => {
    const mockVouchersService: any = {
      generateBatch: vi.fn(async (params: any) => ({ created: 1, vouchers: [] })),
    };
    const controller = new VouchersController(mockVouchersService);

    const expiryStr = '2026-12-31T23:59:59.000Z';
    await controller.generateBatch({
      venueId: 'venue-1',
      planId: 'plan-1',
      quantity: 5,
      expiresAt: expiryStr,
    });

    expect(mockVouchersService.generateBatch).toHaveBeenCalledWith({
      venueId: 'venue-1',
      planId: 'plan-1',
      quantity: 5,
      expiresAt: new Date(expiryStr),
    });
  });

  it('delegates redeem to vouchers.redeem', async () => {
    const mockVouchersService: any = {
      redeem: vi.fn(async (code: string, body: any) => ({ voucherId: 'v-1', status: 'redeemed' })),
    };
    const controller = new VouchersController(mockVouchersService);

    const body = { routerId: 'r-1', deviceId: 'dev-1', ip: '192.168.88.10', mac: 'AA:BB:CC:DD:EE:FF' };
    const res = await controller.redeem('VOUCH-1', body);

    expect(mockVouchersService.redeem).toHaveBeenCalledWith('VOUCH-1', body);
    expect(res.status).toBe('redeemed');
  });

  it('delegates revoke to vouchers.revoke', async () => {
    const mockVouchersService: any = {
      revoke: vi.fn(async (id: string) => ({ id, status: 'REVOKED' })),
    };
    const controller = new VouchersController(mockVouchersService);
    const res = await controller.revoke('v-123');
    expect(mockVouchersService.revoke).toHaveBeenCalledWith('v-123');
    expect(res.status).toBe('REVOKED');
  });

  it('delegates sync to vouchers.syncVouchers', async () => {
    const mockVouchersService: any = {
      syncVouchers: vi.fn(async (params: any) => ({ synced: 1, created: 1, updated: 0 })),
    };
    const controller = new VouchersController(mockVouchersService);

    const body = {
      venueId: 'venue-1',
      vouchers: [{ code: 'CODE1', password: 'PASS', sold: true }],
    };
    const res = await controller.sync(body);

    expect(mockVouchersService.syncVouchers).toHaveBeenCalledWith(body);
    expect(res).toEqual({ synced: 1, created: 1, updated: 0 });
  });

  it('delegates markSold to vouchers.markSold', async () => {
    const mockVouchersService: any = {
      markSold: vi.fn(async (code: string, sold: boolean) => ({ ok: true, code, sold })),
    };
    const controller = new VouchersController(mockVouchersService);

    const res = await controller.markSold('CODE1', { sold: true });

    expect(mockVouchersService.markSold).toHaveBeenCalledWith('CODE1', true);
    expect(res).toEqual({ ok: true, code: 'CODE1', sold: true });
  });
});
