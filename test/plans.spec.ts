import { describe, it, expect } from 'vitest';
import { PlansService } from '../src/modules/plans/plans.service';

describe('PlansService Duration & Profile Formatting', () => {
  const service = new PlansService({} as any);

  it('correctly formats plan properties and profiles', () => {
    const rawPlan = {
      id: 'plan_1hr',
      venueId: 'venue-1',
      name: '1 Hour Quick Surf',
      description: 'Quick surf',
      priceMinor: 20000,
      durationSeconds: 3600,
      dataLimitBytes: null,
      rateLimit: null,
      simultaneousDevices: 1,
      mode: 'ELAPSED',
      version: 1,
      active: true,
      createdAt: new Date(),
    };

    const formatted = (service as any).formatPlan(rawPlan);

    expect(formatted.priceNGN).toBe(200);
    expect(formatted.amountKobo).toBe(20000);
    expect(formatted.duration).toBe('1h');
    expect(formatted.profile).toBe('profile_1h');
    expect(formatted.limitUptime).toBe('1h');
  });

  it('correctly formats 12h and 24h profiles', () => {
    const plan12h = {
      id: 'plan_12hr',
      venueId: 'venue-1',
      name: '12 Hour Access',
      priceMinor: 80000,
      durationSeconds: 43200,
      active: true,
    };
    const formatted12h = (service as any).formatPlan(plan12h);
    expect(formatted12h.duration).toBe('12h');
    expect(formatted12h.profile).toBe('profile_12h');

    const plan24h = {
      id: 'plan_24hr',
      venueId: 'venue-1',
      name: '24 Hour Unlimited',
      priceMinor: 150000,
      durationSeconds: 86400,
      active: true,
    };
    const formatted24h = (service as any).formatPlan(plan24h);
    expect(formatted24h.duration).toBe('1d');
    expect(formatted24h.profile).toBe('profile_1d');
  });
});
