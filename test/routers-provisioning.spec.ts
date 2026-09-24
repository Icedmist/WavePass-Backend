import { describe, it, expect } from 'vitest';
import { RoutersService } from '../src/modules/routers/routers.service';

describe('RoutersService.generateProvisionScript (Auto-rejoin & Profile Fixes)', () => {
  const service = new RoutersService({} as any, {} as any);

  it('includes addresses-per-mac=1 on the hotspot server instance, not profile', () => {
    const script = service.generateProvisionScript('gw-123');
    expect(script).toContain('/ip hotspot add name="wavepass-hotspot"');
    expect(script).toContain('addresses-per-mac=1');
    // Ensure addresses-per-mac is NOT placed on /ip hotspot profile add
    const profileAddSection = script.split('/ip hotspot add')[0];
    expect(profileAddSection).not.toContain('addresses-per-mac');
  });

  it('configures long DHCP lease time to avoid duplicate host table entries and IP churn', () => {
    const script = service.generateProvisionScript('gw-123');
    expect(script).toContain('/ip dhcp-server set [find] lease-time=1d');
  });

  it('places add-mac-cookie=yes and mac-cookie-timeout=3d on user profiles', () => {
    const script = service.generateProvisionScript('gw-123');
    expect(script).toContain('add-mac-cookie=yes');
    expect(script).toContain('mac-cookie-timeout=3d');
    expect(script).toContain('name="profile_1h"');
    expect(script).toContain('name="profile_12h"');
    expect(script).toContain('name="profile_1d"');
  });
});
