import { describe, it, expect, vi } from 'vitest';
import { VenuesService } from '../src/modules/venues/venues.service';
import { ConflictException, NotFoundException } from '@nestjs/common';

function mockPrisma() {
  const venues = new Map<string, any>();
  return {
    venue: {
      findMany: vi.fn(async () => [...venues.values()]),
      findUnique: vi.fn(async ({ where }: any) => {
        if (where.id) return venues.get(where.id) || null;
        if (where.slug) {
          return [...venues.values()].find((v) => v.slug === where.slug) || null;
        }
        return null;
      }),
      findFirst: vi.fn(async () => venues.values().next().value || null),
      create: vi.fn(async ({ data }: any) => {
        const id = `venue-${venues.size + 1}`;
        const record = { id, ...data, routers: [], plans: [] };
        venues.set(id, record);
        return record;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const existing = venues.get(where.id);
        if (!existing) throw new Error('Not found');
        const updated = { ...existing, ...data };
        venues.set(where.id, updated);
        return updated;
      }),
    },
    _store: venues,
  } as any;
}

describe('VenuesService unit tests', () => {
  describe('checkSlugAvailability', () => {
    it('rejects empty or whitespace-only slug', async () => {
      const prisma = mockPrisma();
      const svc = new VenuesService(prisma);
      const res = await svc.checkSlugAvailability('   ');
      expect(res.available).toBe(false);
      expect(res.reason).toBe('Slug cannot be empty');
    });

    it('rejects slug with invalid characters', async () => {
      const prisma = mockPrisma();
      const svc = new VenuesService(prisma);
      const res = await svc.checkSlugAvailability('bad_slug!');
      expect(res.available).toBe(false);
      expect(res.reason).toContain('Only lowercase letters');
    });

    it('rejects slug shorter than 2 chars', async () => {
      const prisma = mockPrisma();
      const svc = new VenuesService(prisma);
      const res = await svc.checkSlugAvailability('a');
      expect(res.available).toBe(false);
      expect(res.reason).toContain('at least 2 characters');
    });

    it('rejects reserved slug keywords', async () => {
      const prisma = mockPrisma();
      const svc = new VenuesService(prisma);
      for (const reserved of ['admin', 'api', 'portal', 'billing']) {
        const res = await svc.checkSlugAvailability(reserved);
        expect(res.available).toBe(false);
        expect(res.reason).toContain('reserved by the system');
      }
    });

    it('returns available: true for untaken valid slug', async () => {
      const prisma = mockPrisma();
      const svc = new VenuesService(prisma);
      const res = await svc.checkSlugAvailability('great-cafe');
      expect(res.available).toBe(true);
      expect(res.slug).toBe('great-cafe');
    });

    it('returns available: true if slug matches the existing venueId (isCurrent)', async () => {
      const prisma = mockPrisma();
      prisma._store.set('venue-1', { id: 'venue-1', slug: 'my-store' });
      const svc = new VenuesService(prisma);

      const res = await svc.checkSlugAvailability('my-store', 'venue-1');
      expect(res.available).toBe(true);
      expect(res.isCurrent).toBe(true);
    });

    it('returns available: false if slug is taken by another venue', async () => {
      const prisma = mockPrisma();
      prisma._store.set('venue-1', { id: 'venue-1', slug: 'my-store' });
      const svc = new VenuesService(prisma);

      const res = await svc.checkSlugAvailability('my-store', 'venue-2');
      expect(res.available).toBe(false);
      expect(res.reason).toContain('already taken');
    });
  });

  describe('createVenue', () => {
    it('creates venue with normalized slug and defaults', async () => {
      const prisma = mockPrisma();
      const svc = new VenuesService(prisma);
      const res = await svc.createVenue({
        name: 'Sunny Cafe',
        slug: 'SUNNY-CAFE',
      });

      expect(res.slug).toBe('sunny-cafe');
      expect(res.timezone).toBe('Africa/Lagos');
      expect(res.currency).toBe('NGN');
      expect(res.name).toBe('Sunny Cafe');
    });

    it('throws ConflictException if slug already exists', async () => {
      const prisma = mockPrisma();
      prisma._store.set('v-1', { id: 'v-1', slug: 'taken-slug' });
      const svc = new VenuesService(prisma);

      await expect(
        svc.createVenue({ name: 'Duplicate', slug: 'taken-slug' }),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('updateVenue', () => {
    it('throws NotFoundException if venue not found', async () => {
      const prisma = mockPrisma();
      const svc = new VenuesService(prisma);
      await expect(
        svc.updateVenue('v-999', { name: 'New Name' }),
      ).rejects.toThrow(NotFoundException);
    });

    it('updates venue fields and validates updated slug', async () => {
      const prisma = mockPrisma();
      prisma._store.set('v-1', { id: 'v-1', name: 'Old', slug: 'old-slug' });
      const svc = new VenuesService(prisma);

      const res = await svc.updateVenue('v-1', { name: 'New', slug: 'new-slug' });
      expect(res.name).toBe('New');
      expect(res.slug).toBe('new-slug');
    });

    it('throws ConflictException if updated slug is taken by another venue', async () => {
      const prisma = mockPrisma();
      prisma._store.set('v-1', { id: 'v-1', slug: 'slug-one' });
      prisma._store.set('v-2', { id: 'v-2', slug: 'slug-two' });
      const svc = new VenuesService(prisma);

      await expect(
        svc.updateVenue('v-1', { slug: 'slug-two' }),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('getReadiness', () => {
    it('reports unready when plans or routers are missing', async () => {
      const prisma = mockPrisma();
      prisma._store.set('v-1', { id: 'v-1', slug: 'store', plans: [], routers: [] });
      const svc = new VenuesService(prisma);

      const res = await svc.getReadiness('v-1');
      expect(res.ready).toBe(false);
      expect(res.missing).toHaveLength(2);
      expect(res.hasPlans).toBe(false);
      expect(res.hasRouter).toBe(false);
    });

    it('reports ready when both active plans and routers are present', async () => {
      const prisma = mockPrisma();
      prisma._store.set('v-1', {
        id: 'v-1',
        slug: 'store',
        plans: [{ id: 'p-1' }],
        routers: [{ id: 'r-1', status: 'ONLINE' }],
      });
      const svc = new VenuesService(prisma);

      const res = await svc.getReadiness('v-1');
      expect(res.ready).toBe(true);
      expect(res.missing).toHaveLength(0);
      expect(res.planCount).toBe(1);
      expect(res.routerCount).toBe(1);
    });
  });

  describe('getVenueByHost', () => {
    it('returns null for localhost, IP, or short host', async () => {
      const prisma = mockPrisma();
      const svc = new VenuesService(prisma);
      expect(await svc.getVenueByHost('localhost:3000')).toBeNull();
      expect(await svc.getVenueByHost('127.0.0.1:8080')).toBeNull();
      expect(await svc.getVenueByHost('example.com')).toBeNull();
    });

    it('returns null for reserved subdomains like www or api', async () => {
      const prisma = mockPrisma();
      const svc = new VenuesService(prisma);
      expect(await svc.getVenueByHost('www.nexawavepass.com')).toBeNull();
      expect(await svc.getVenueByHost('api.nexawavepass.com')).toBeNull();
      expect(await svc.getVenueByHost('admin.nexawavepass.com')).toBeNull();
    });

    it('resolves venue by subdomain slug', async () => {
      const prisma = mockPrisma();
      prisma._store.set('v-1', { id: 'v-1', slug: 'lounge', name: 'Lounge Cafe', plans: [], routers: [] });
      const svc = new VenuesService(prisma);

      const venue = await svc.getVenueByHost('lounge.nexawavepass.com');
      expect(venue).not.toBeNull();
      expect(venue?.slug).toBe('lounge');
    });
  });

  describe('getDefaultVenue', () => {
    it('returns existing default venue if found', async () => {
      const prisma = mockPrisma();
      prisma._store.set('v-def', { id: 'v-def', slug: 'default', name: 'Existing Default', plans: [], routers: [] });
      const svc = new VenuesService(prisma);

      const venue = await svc.getDefaultVenue();
      expect(venue.id).toBe('v-def');
    });

    it('creates and auto-bootstraps default venue if none exists', async () => {
      const prisma = mockPrisma();
      const svc = new VenuesService(prisma);

      const venue = await svc.getDefaultVenue();
      expect(venue.slug).toBe('default');
      expect(venue.name).toBe('WavePass Default Venue');
    });
  });
});
