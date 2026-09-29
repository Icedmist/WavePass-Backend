import { describe, it, expect, vi } from 'vitest';
import { CashoutsController } from '../src/modules/cashouts/cashouts.controller';

describe('CashoutsController unit tests', () => {
  it('delegates balance to cashouts.venueBalance', async () => {
    const mockCashouts: any = {
      venueBalance: vi.fn(async (venueId: string) => ({ venueId, availableMinor: 200000 })),
    };
    const controller = new CashoutsController(mockCashouts);

    const res = await controller.balance('venue-1');
    expect(mockCashouts.venueBalance).toHaveBeenCalledWith('venue-1');
    expect(res.availableMinor).toBe(200000);
  });

  it('delegates payments to cashouts.listPaymentsByVenue with parsed limit or default 50', async () => {
    const mockCashouts: any = {
      listPaymentsByVenue: vi.fn(async (venueId: string, limit: number) => []),
    };
    const controller = new CashoutsController(mockCashouts);

    await controller.payments('venue-1', '25');
    expect(mockCashouts.listPaymentsByVenue).toHaveBeenCalledWith('venue-1', 25);

    await controller.payments('venue-1', undefined);
    expect(mockCashouts.listPaymentsByVenue).toHaveBeenCalledWith('venue-1', 50);
  });

  it('delegates registerBank to cashouts.registerBankAccount', async () => {
    const mockCashouts: any = {
      registerBankAccount: vi.fn(async (dto: any) => ({ id: 'bank-1', ...dto })),
    };
    const controller = new CashoutsController(mockCashouts);

    const dto = { venueId: 'venue-1', accountName: 'Store', accountNumber: '0123456789', bankCode: '058', bankName: 'GTBank' };
    const res = await controller.registerBank(dto);
    expect(mockCashouts.registerBankAccount).toHaveBeenCalledWith(dto);
    expect(res.id).toBe('bank-1');
  });

  it('delegates listBank to cashouts.listBankAccounts', async () => {
    const mockCashouts: any = {
      listBankAccounts: vi.fn(async (venueId: string) => [{ id: 'bank-1', venueId }]),
    };
    const controller = new CashoutsController(mockCashouts);

    const res = await controller.listBank('venue-1');
    expect(mockCashouts.listBankAccounts).toHaveBeenCalledWith('venue-1');
    expect(res).toHaveLength(1);
  });

  it('delegates request to cashouts.requestCashout', async () => {
    const mockCashouts: any = {
      requestCashout: vi.fn(async (dto: any) => ({ id: 'co-1', status: 'COMPLETED' })),
    };
    const controller = new CashoutsController(mockCashouts);

    const dto: any = { venueId: 'venue-1', amountMinor: 100000, password: 'secret-password' };
    const res = await controller.request(dto);
    expect(mockCashouts.requestCashout).toHaveBeenCalledWith(dto);
    expect(res.status).toBe('COMPLETED');
  });

  it('delegates confirm to cashouts.confirmCashout with adminPassword', async () => {
    const mockCashouts: any = {
      confirmCashout: vi.fn(async (dto: any, pw: string) => ({ id: dto.cashoutId, status: 'COMPLETED' })),
    };
    const controller = new CashoutsController(mockCashouts);

    const dto: any = { cashoutId: 'co-pending', adminPassword: 'admin-secret' };
    const res = await controller.confirm(dto);
    expect(mockCashouts.confirmCashout).toHaveBeenCalledWith(dto, 'admin-secret');
    expect(res.status).toBe('COMPLETED');
  });

  it('delegates finalizeOtp to cashouts.finalizeCashoutOtp', async () => {
    const mockCashouts: any = {
      finalizeCashoutOtp: vi.fn(async (body: any) => ({ ok: true, status: 'COMPLETED' })),
    };
    const controller = new CashoutsController(mockCashouts);

    const body = { cashoutId: 'co-otp', otp: '123456' };
    const res = await controller.finalizeOtp(body);
    expect(mockCashouts.finalizeCashoutOtp).toHaveBeenCalledWith(body);
    expect(res.ok).toBe(true);
  });

  it('delegates reject to cashouts.rejectCashout', async () => {
    const mockCashouts: any = {
      rejectCashout: vi.fn(async (id: string, pw: string, reason?: string) => ({ id, status: 'REJECTED' })),
    };
    const controller = new CashoutsController(mockCashouts);

    const res = await controller.reject('co-bad', { adminPassword: 'pwd', reason: 'Suspect activity' });
    expect(mockCashouts.rejectCashout).toHaveBeenCalledWith('co-bad', 'pwd', 'Suspect activity');
    expect(res.status).toBe('REJECTED');
  });

  it('delegates list to cashouts.listByVenue', async () => {
    const mockCashouts: any = {
      listByVenue: vi.fn(async (venueId: string) => [{ id: 'co-1', venueId }]),
    };
    const controller = new CashoutsController(mockCashouts);

    const res = await controller.list('venue-1');
    expect(mockCashouts.listByVenue).toHaveBeenCalledWith('venue-1');
    expect(res).toHaveLength(1);
  });
});
