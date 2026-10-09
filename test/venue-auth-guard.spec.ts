import { describe, it, expect, vi, beforeEach } from 'vitest';
import { VenueAuthGuard } from '../src/modules/virtual-accounts/venue-auth.guard';

function makeContext(headers: any, params: any = {}, body: any = {}) {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ headers, params, body }),
    }),
  } as any;
}

function makeAuth(email = 'platform@admin.test') {
  return {
    verifyToken: vi.fn(() => ({ role: 'admin', email })),
    getAdminEmail: () => 'platform@admin.test',
  } as any;
}

function makePrisma(opts: { member?: any; user?: any; vaVenueId?: string | null } = {}) {
  return {
    user: { findUnique: vi.fn(async () => opts.user ?? null) },
    venueMember: { findUnique: vi.fn(async () => opts.member ?? null) },
    virtualAccount: { findUnique: vi.fn(async () => (opts.vaVenueId ? { venueId: opts.vaVenueId } : null)) },
  } as any;
}

describe('VenueAuthGuard', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.SUPABASE_SECRET_KEY;
  });

  it('rejects requests with no Authorization header', async () => {
    const guard = new VenueAuthGuard(makeAuth(), makePrisma());
    await expect(guard.canActivate(makeContext({}))).rejects.toThrow('Missing or invalid auth token');
  });

  it('allows the platform admin for any venue', async () => {
    const guard = new VenueAuthGuard(makeAuth('platform@admin.test'), makePrisma());
    const ok = await guard.canActivate(makeContext({ authorization: 'Bearer admin-jwt' }, { venueId: 'venue-1' }));
    expect(ok).toBe(true);
  });

  it('allows a caller whose user id is a VenueMember of the venue (admin JWT path)', async () => {
    const prisma = makePrisma({ user: { id: 'user-1' }, member: { venueId: 'venue-1', userId: 'user-1', role: 'Owner' } });
    const guard = new VenueAuthGuard(makeAuth('owner@venue.test'), prisma);
    const ok = await guard.canActivate(makeContext({ authorization: 'Bearer admin-jwt' }, { venueId: 'venue-1' }));
    expect(ok).toBe(true);
  });

  it('rejects a caller who is not a member of the venue', async () => {
    const prisma = makePrisma({ user: { id: 'user-2' }, member: null });
    const guard = new VenueAuthGuard(makeAuth('stranger@venue.test'), prisma);
    await expect(
      guard.canActivate(makeContext({ authorization: 'Bearer admin-jwt' }, { venueId: 'venue-1' })),
    ).rejects.toThrow('Caller does not operate this venue');
  });

  it('resolves venueId through the virtual account for GET /:id and enforces membership', async () => {
    const prisma = makePrisma({
      user: { id: 'sb-uid-1' },
      member: { venueId: 'venue-9', userId: 'sb-uid-1', role: 'Owner' },
      vaVenueId: 'venue-9',
    });
    const guard = new VenueAuthGuard(makeAuth('owner@venue.test'), prisma);
    const ok = await guard.canActivate(makeContext({ authorization: 'Bearer admin-jwt' }, { id: 'va-1' }));
    expect(ok).toBe(true);
    expect(prisma.venueMember.findUnique).toHaveBeenCalledWith({
      where: { venueId_userId: { venueId: 'venue-9', userId: 'sb-uid-1' } },
    });
  });

  it('rejects when the virtual account for GET /:id does not exist', async () => {
    const guard = new VenueAuthGuard(makeAuth(), makePrisma({ vaVenueId: null }));
    await expect(
      guard.canActivate(makeContext({ authorization: 'Bearer supabase-token' }, { id: 'missing' })),
    ).rejects.toThrow('Venue could not be resolved');
  });

  it('reads venueId from the request body for POST /', async () => {
    const prisma = makePrisma({ user: { id: 'user-1' }, member: { venueId: 'venue-3', userId: 'user-1' } });
    const guard = new VenueAuthGuard(makeAuth('owner@venue.test'), prisma);
    const ok = await guard.canActivate(makeContext({ authorization: 'Bearer admin-jwt' }, {}, { venueId: 'venue-3' }));
    expect(ok).toBe(true);
  });

  describe('Supabase access tokens', () => {
    it('verifies the token against Supabase /auth/v1/user and uses the returned uid for membership', async () => {
      process.env.SUPABASE_URL = 'https://project.supabase.co';
      process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key';
      const fetchSpy = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ id: 'sb-uid-1', email: 'owner@venue.test' }),
      });
      vi.stubGlobal('fetch', fetchSpy);

      // Backend JWT verification fails for a Supabase token.
      const auth = { verifyToken: vi.fn(() => { throw new Error('invalid token'); }), getAdminEmail: () => 'platform@admin.test' } as any;
      const prisma = makePrisma({ member: { venueId: 'venue-1', userId: 'sb-uid-1', role: 'Owner' } });
      const guard = new VenueAuthGuard(auth, prisma);

      const ok = await guard.canActivate(makeContext({ authorization: 'Bearer sb-access-token' }, { venueId: 'venue-1' }));
      expect(ok).toBe(true);
      expect(fetchSpy).toHaveBeenCalledWith(
        'https://project.supabase.co/auth/v1/user',
        expect.objectContaining({
          headers: { apikey: 'service-key', Authorization: 'Bearer sb-access-token' },
        }),
      );
      // Membership resolved directly from the Supabase uid — no User lookup needed.
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
      expect(prisma.venueMember.findUnique).toHaveBeenCalledWith({
        where: { venueId_userId: { venueId: 'venue-1', userId: 'sb-uid-1' } },
      });
    });

    it('rejects when Supabase rejects the token', async () => {
      process.env.SUPABASE_URL = 'https://project.supabase.co';
      process.env.SUPABASE_SECRET_KEY = 'secret-key';
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }));
      const auth = { verifyToken: vi.fn(() => { throw new Error('invalid token'); }), getAdminEmail: () => 'platform@admin.test' } as any;
      const guard = new VenueAuthGuard(auth, makePrisma());
      await expect(
        guard.canActivate(makeContext({ authorization: 'Bearer expired' }, { venueId: 'venue-1' })),
      ).rejects.toThrow('Missing or invalid auth token');
    });

    it('rejects when Supabase env is not configured', async () => {
      const auth = { verifyToken: vi.fn(() => { throw new Error('invalid token'); }), getAdminEmail: () => 'platform@admin.test' } as any;
      const guard = new VenueAuthGuard(auth, makePrisma());
      await expect(
        guard.canActivate(makeContext({ authorization: 'Bearer sb-access-token' }, { venueId: 'venue-1' })),
      ).rejects.toThrow('Missing or invalid auth token');
    });
  });
});
