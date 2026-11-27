import { describe, it, expect, vi } from 'vitest';
import { PortalService } from '../src/modules/portal/portal.service';
import { RoutersService } from '../src/modules/routers/routers.service';

describe('Cloud Voucher Router Sync & Auto-Rejoin Parity', () => {
  it('exports ISSUED, ACTIVE, and REDEEMED vouchers with custom passwords, data limits, and WP: auto-rejoin bindings', async () => {
    const mockPrisma: any = {
      venue: {
        findFirst: vi.fn().mockResolvedValue({ id: 'venue-1', name: 'Nexa Lounge', slug: 'nexa-lounge' }),
        findUnique: vi.fn().mockResolvedValue({ id: 'venue-1', name: 'Nexa Lounge', slug: 'nexa-lounge' }),
      },
      voucher: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'v1',
            displayCodeEnc: 'ABCD-1234',
            password: 'secret-pw',
            status: 'ISSUED',
            redeemedMac: null,
            expiresAt: new Date(Date.now() + 86400_000),
            plan: { durationSeconds: 3600, simultaneousDevices: 1, rateLimit: 'profile_1h', dataLimitBytes: 536870912 },
          },
          {
            id: 'v2',
            displayCodeEnc: '554433',
            password: null,
            status: 'ACTIVE',
            redeemedMac: 'aa:bb:cc:dd:ee:ff',
            expiresAt: new Date(Date.now() + 3600_000),
            plan: { durationSeconds: 3600, simultaneousDevices: 1, rateLimit: 'profile_1h', dataLimitBytes: null },
          },
        ]),
      },
    };

    const portal = new PortalService(mockPrisma, {} as any, {} as any, {} as any, {} as any, {} as any);
    const script = (await portal.generateRouterSyncScript('nexa-lounge')) as string;

    expect(mockPrisma.voucher.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          venueId: 'venue-1',
          status: { in: ['ISSUED', 'ACTIVE', 'REDEEMED'] },
        }),
      }),
    );

    // Unused ISSUED voucher exported with its password, data limit, and no MAC lock
    expect(script).toContain('name="ABCD-1234" password="secret-pw" profile="profile_1h" limit-uptime=1h limit-bytes-total=536870912 comment="WavePass Cloud Sync"');
    expect(script).not.toContain('comment="WP:ABCD-1234"');

    // ACTIVE voucher exported with MAC lock and unified WP: bypassed IP-binding for auto-rejoin
    expect(script).toContain('name="554433" password="554433" profile="profile_1h" limit-uptime=1h mac-address="AA:BB:CC:DD:EE:FF"');
    expect(script).toContain('mac-address="AA:BB:CC:DD:EE:FF" type=bypassed comment="WP:554433"');

    // Orphan cleanup strictly guards WP: prefix so non-WavePass bindings are never touched
    expect(script).toContain('[:pick $bc 0 3] = "WP:"');
    expect(script).not.toContain('WavePass:554433');
  });

  it('includes wavepass-cloud-sync 1m scheduler in RoutersService.generateProvisionScript', () => {
    const routers = new RoutersService({} as any, {} as any);
    const script = routers.generateProvisionScript('gw-1', 'my-cafe');
    expect(script).toContain('name="wavepass-cloud-sync"');
    expect(script).toContain('/api/v1/portal/router-sync?venueSlug=my-cafe');
    expect(script).toContain('interval=1m on-event="wavepass-cloud-sync"');
    expect(script).toContain('[:pick $bc 0 3] = "WP:"');
  });
});
