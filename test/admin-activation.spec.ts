import { describe, it, expect, beforeEach } from 'vitest';
import { AdminService } from '../src/modules/admin/admin.service';

describe('AdminService Activation Codes & System Admin Suite', () => {
  let service: AdminService;

  beforeEach(() => {
    service = new AdminService({} as any, {} as any, {} as any, {} as any);
  });

  it('generates activation codes in WP-ACT-XXXX-XXXX format', async () => {
    const res = await service.generateActivationCodes(3, 'Test Batch', 1, 'talk2icedmist@gmail.com');
    expect(res.ok).toBe(true);
    expect(res.count).toBe(3);
    expect(res.codes.length).toBe(3);

    for (const code of res.codes) {
      expect(code.code).toMatch(/^WP-ACT-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
      expect(code.status).toBe('AUTHORIZED');
      expect(code.quota).toBe(1);
    }
  });

  it('permanently activates talk2icedmist@gmail.com as super admin', async () => {
    const check = await service.checkAccountActivation('talk2icedmist@gmail.com');
    expect(check.ok).toBe(true);
    expect(check.activated).toBe(true);
    expect(check.role).toBe('system_admin');
  });

  it('checks unactivated accounts and redeems authorized activation code', async () => {
    const newEmail = 'shopowner@venue.com';
    const checkBefore = await service.checkAccountActivation(newEmail);
    expect(checkBefore.activated).toBe(false);

    // Generate code
    const gen = await service.generateActivationCodes(1, 'Shop 1 Activation');
    const targetCode = gen.codes[0].code;

    // Redeem code
    const redeemRes = await service.redeemActivationCode(targetCode, newEmail, 'venue-uuid-123');
    expect(redeemRes.ok).toBe(true);
    expect(redeemRes.code!.status).toBe('USED');
    expect(redeemRes.code!.redeemedBy).toBe(newEmail);

    // Cannot redeem twice
    const secondRedeem = await service.redeemActivationCode(targetCode, 'another@venue.com');
    expect(secondRedeem.ok).toBe(false);
    expect(secondRedeem.error).toContain('already been redeemed');

    // Check account activation now returns true
    const checkAfter = await service.checkAccountActivation(newEmail);
    expect(checkAfter.activated).toBe(true);
    expect(checkAfter.code).toBe(targetCode);
  });

  it('allows system admin to revoke and re-authorize activation code', async () => {
    const gen = await service.generateActivationCodes(1, 'Revoke test');
    const targetCode = gen.codes[0].code;

    // Revoke
    await service.authorizeActivationCode(targetCode, 'REVOKED');
    const redeemRevoked = await service.redeemActivationCode(targetCode, 'test@venue.com');
    expect(redeemRevoked.ok).toBe(false);
    expect(redeemRevoked.error).toContain('not authorized');

    // Re-authorize
    await service.authorizeActivationCode(targetCode, 'AUTHORIZED');
    const redeemAuthorized = await service.redeemActivationCode(targetCode, 'test@venue.com');
    expect(redeemAuthorized.ok).toBe(true);
  });

  it('logs audit records and retrieves system health', async () => {
    await service.logAudit({
      action: 'ROUTER_REBOOT_TRIGGERED',
      category: 'ROUTER',
      actor: 'talk2icedmist@gmail.com',
      details: { routerId: 'r-1' },
      status: 'SUCCESS',
    });

    const audits = await service.getAuditLogs('ROUTER');
    expect(audits.ok).toBe(true);
    expect(audits.logs.some((l) => l.action === 'ROUTER_REBOOT_TRIGGERED')).toBe(true);

    const health = await service.getSystemHealth();
    expect(health.ok).toBe(true);
    expect(health.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(health.memory).toHaveProperty('rssMB');
  });
});
