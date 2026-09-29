import { describe, it, expect, vi } from 'vitest';
import { PlansService } from '../src/modules/plans/plans.service';
import { NotFoundException } from '@nestjs/common';

function mockPrisma() {
  const store = new Map<string, any>();
  return {
    _store: store,
    plan: {
      findMany: vi.fn(async ({ where }: any) => {
        return [...store.values()].filter((p) => {
          if (where?.active !== undefined && p.active !== where.active) return false;
          if (where?.venueId && p.venueId !== where.venueId) return false;
          return true;
        });
      }),
      findUnique: vi.fn(async ({ where }: any) => store.get(where.id) || null),
      findFirst: vi.fn(async ({ where }: any) => {
        if (!where) return store.values().next().value || null;
        for (const p of store.values()) {
          if (where.active !== undefined && p.active !== where.active) continue;
          if (where.OR) {
            const matchesOr = where.OR.some((clause: any) => {
              if (clause.id?.contains && p.id.toLowerCase().includes(clause.id.contains.toLowerCase())) return true;
              if (clause.name?.contains && p.name.toLowerCase().includes(clause.name.contains.toLowerCase())) return true;
              return false;
            });
            if (matchesOr) return p;
          } else {
            return p;
          }
        }
        return null;
      }),
      create: vi.fn(async ({ data }: any) => {
        const id = `plan-${store.size + 1}`;
        const record = { id, createdAt: new Date(), ...data };
        store.set(id, record);
        return record;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const existing = store.get(where.id);
        if (!existing) throw new Error('Not found');
        const updated = { ...existing, ...data };
        store.set(where.id, updated);
        return updated;
      }),
    },
  } as any;
}

describe('PlansService unit tests', () => {
  it('listPlans filters by active and optional venueId and formats each plan', async () => {
    const prisma = mockPrisma();
    prisma._store.set('p1', {
      id: 'p1', venueId: 'venue-1', name: '1 Hour', priceMinor: 20000, durationSeconds: 3600, active: true,
    });
    prisma._store.set('p2', {
      id: 'p2', venueId: 'venue-2', name: '2 Hours', priceMinor: 35000, durationSeconds: 7200, active: true,
    });
    prisma._store.set('p3', {
      id: 'p3', venueId: 'venue-1', name: 'Inactive', priceMinor: 10000, durationSeconds: 1800, active: false,
    });

    const svc = new PlansService(prisma);
    const plansForVenue1 = await svc.listPlans('venue-1');

    expect(plansForVenue1).toHaveLength(1);
    expect(plansForVenue1[0].id).toBe('p1');
    expect(plansForVenue1[0].duration).toBe('1h');
    expect(plansForVenue1[0].profile).toBe('profile_1h');
    expect(plansForVenue1[0].priceNGN).toBe(200);

    const allActive = await svc.listPlans();
    expect(allActive).toHaveLength(2);
  });

  describe('getPlanById', () => {
    it('finds plan directly by id', async () => {
      const prisma = mockPrisma();
      prisma._store.set('plan_1hr', {
        id: 'plan_1hr', venueId: 'venue-1', name: '1 Hour', priceMinor: 20000, durationSeconds: 3600, active: true,
      });
      const svc = new PlansService(prisma);
      const plan = await svc.getPlanById('plan_1hr');
      expect(plan.id).toBe('plan_1hr');
    });

    it('resolves common aliases e.g. plan_1h -> plan_1hr', async () => {
      const prisma = mockPrisma();
      prisma._store.set('plan_1hr', {
        id: 'plan_1hr', venueId: 'venue-1', name: '1 Hour', priceMinor: 20000, durationSeconds: 3600, active: true,
      });
      const svc = new PlansService(prisma);
      const plan = await svc.getPlanById('plan_1h');
      expect(plan.id).toBe('plan_1hr');
    });

    it('falls back to search by name/partial id', async () => {
      const prisma = mockPrisma();
      prisma._store.set('custom-uuid-plan', {
        id: 'custom-uuid-plan', venueId: 'venue-1', name: 'Weekend Special', priceMinor: 50000, durationSeconds: 86400, active: true,
      });
      const svc = new PlansService(prisma);
      const plan = await svc.getPlanById('Weekend');
      expect(plan.id).toBe('custom-uuid-plan');
    });

    it('throws NotFoundException when no plans match', async () => {
      const prisma = mockPrisma();
      const svc = new PlansService(prisma);
      await expect(svc.getPlanById('non-existent')).rejects.toThrow(NotFoundException);
    });
  });

  describe('createPlan & updatePlan versioning', () => {
    it('creates a new plan with version 1', async () => {
      const prisma = mockPrisma();
      const svc = new PlansService(prisma);
      const plan = await svc.createPlan({
        venueId: 'venue-1',
        name: 'Day Pass',
        priceMinor: 50000,
        durationSeconds: 86400,
      });

      expect(plan.version).toBe(1);
      expect(plan.name).toBe('Day Pass');
      expect(plan.duration).toBe('1d');
    });

    it('increments version when priceMinor or durationSeconds change', async () => {
      const prisma = mockPrisma();
      prisma._store.set('p-1', {
        id: 'p-1', venueId: 'venue-1', name: 'Old Plan', priceMinor: 30000, durationSeconds: 3600, version: 1, active: true,
      });
      const svc = new PlansService(prisma);

      // Price changed -> bump version
      const updated = await svc.updatePlan('p-1', { priceMinor: 40000 });
      expect(updated.version).toBe(2);
      expect(updated.priceMinor).toBe(40000);

      // Duration changed -> bump version
      const updated2 = await svc.updatePlan('p-1', { durationSeconds: 7200 });
      expect(updated2.version).toBe(3);

      // Description changed only -> version stays same
      const updated3 = await svc.updatePlan('p-1', { description: 'Updated description' });
      expect(updated3.version).toBe(3);
    });

    it('deactivates plan successfully', async () => {
      const prisma = mockPrisma();
      prisma._store.set('p-1', {
        id: 'p-1', venueId: 'venue-1', name: 'Active Plan', priceMinor: 30000, durationSeconds: 3600, version: 1, active: true,
      });
      const svc = new PlansService(prisma);
      await svc.deactivatePlan('p-1');
      expect(prisma._store.get('p-1').active).toBe(false);
    });
  });
});
