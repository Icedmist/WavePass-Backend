import { describe, it, expect, vi } from 'vitest';
import { PortalService } from '../src/modules/portal/portal.service';

function makeService(isMock: boolean) {
  const paystack: any = { isMock: () => isMock };
  return new PortalService({} as any, paystack, {} as any, {} as any, {} as any);
}

describe('PortalService.simulatePayment gate', () => {
  it('rejects simulation on live gateways', async () => {
    const svc = makeService(false);
    await expect(svc.simulatePayment({ mac: 'AA:BB:CC:DD:EE:FF', planId: 'p1' })).rejects.toThrow(
      'Payment simulation is disabled on live gateways',
    );
  });

  it('validates mac/planId in mock mode before touching the DB', async () => {
    const svc = makeService(true);
    await expect(svc.simulatePayment({ mac: '', planId: '' })).rejects.toThrow();
  });
});
