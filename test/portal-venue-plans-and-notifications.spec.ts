import { describe, it, expect, vi } from 'vitest';
import { PlansService } from '../src/modules/plans/plans.service';
import { NotificationsService } from '../src/modules/notifications/notifications.service';
import { SessionsService } from '../src/modules/sessions/sessions.service';

describe('Portal Venue Plans & Notification Resolution', () => {
  it('resolves venue by slug and lists plans', async () => {
    const mockPrisma = {
      venue: {
        findFirst: vi.fn().mockResolvedValue({ id: 'uuid-123', slug: 'cafe-bliss' }),
      },
      plan: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'plan-custom-1',
            venueId: 'uuid-123',
            name: 'Café 2 Hours',
            description: 'Fast wifi',
            priceMinor: 30000,
            durationSeconds: 7200,
            active: true,
            createdAt: new Date(),
          },
        ]),
      },
    };

    const plansService = new PlansService(mockPrisma as any);
    const plans = await plansService.listPlans('cafe-bliss');

    expect(mockPrisma.venue.findFirst).toHaveBeenCalled();
    expect(plans).toHaveLength(1);
    expect(plans[0].name).toBe('Café 2 Hours');
    expect(plans[0].priceNGN).toBe(300);
    expect(plans[0].duration).toBe('2h');
  });

  it('matches plan alias within a venue', async () => {
    const mockPrisma = {
      venue: {
        findFirst: vi.fn().mockResolvedValue({ id: 'uuid-venue-99', slug: 'my-venue' }),
      },
      plan: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'plan-custom-1h',
          venueId: 'uuid-venue-99',
          name: 'My Venue 1 Hour',
          priceMinor: 25000,
          durationSeconds: 3600,
          active: true,
          createdAt: new Date(),
        }),
      },
    };

    const plansService = new PlansService(mockPrisma as any);
    const plan = await plansService.getPlanById('plan_1h', 'my-venue');

    expect(plan.id).toBe('plan-custom-1h');
    expect(plan.priceNGN).toBe(250);
  });

  it('resolves venue slug to UUID in NotificationsService.listByVenue', async () => {
    const mockPrisma = {
      venue: {
        findFirst: vi.fn().mockResolvedValue({ id: 'uuid-venue-456', slug: 'sweet-cafe' }),
      },
      notification: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'notif-1',
            venueId: 'uuid-venue-456',
            type: 'PAYMENT',
            title: 'Payment received — ₦500',
            body: 'Pass paid',
            amountMinor: 50000,
            read: false,
          },
        ]),
      },
    };

    const notifService = new NotificationsService(mockPrisma as any);
    const notifs = await notifService.listByVenue('sweet-cafe');

    expect(mockPrisma.venue.findFirst).toHaveBeenCalled();
    expect(mockPrisma.notification.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { venueId: 'uuid-venue-456' } }),
    );
    expect(notifs).toHaveLength(1);
    expect(notifs[0].title).toBe('Payment received — ₦500');
  });

  it('resolves venue slug to UUID in SessionsService.listActiveSessions', async () => {
    const mockPrisma = {
      venue: {
        findFirst: vi.fn().mockResolvedValue({ id: 'uuid-venue-789', slug: 'ocean-lounge' }),
      },
      session: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'sess-1',
            venueId: 'uuid-venue-789',
            status: 'ACTIVE',
            mac: 'AA:BB:CC:DD:EE:FF',
          },
        ]),
      },
    };

    const sessionsService = new SessionsService(mockPrisma as any, {} as any);
    const sessions = await sessionsService.listActiveSessions('ocean-lounge');

    expect(mockPrisma.venue.findFirst).toHaveBeenCalled();
    expect(mockPrisma.session.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: 'ACTIVE', venueId: 'uuid-venue-789' } }),
    );
    expect(sessions).toHaveLength(1);
  });
});
