import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { AdminAuthService } from '../admin/admin-auth.service';
import { PrismaService } from '../../common/prisma.service';

interface CallerIdentity {
  email: string;
  /** Supabase auth uid when the token came from Supabase (backend admin JWTs only carry email). */
  userId?: string;
}

/**
 * Venue-scoped auth for virtual-account endpoints. Follows the same Bearer
 * token pattern as AdminAuthGuard (admin.controller.ts), then additionally
 * verifies the caller actually operates the venue: the platform admin
 * operates every venue, any other caller must be a VenueMember of it.
 *
 * Two token types are accepted:
 *  1. Backend admin JWT (POST /admin/verify-password) — matches the web admin
 *     dashboard and the app's system-admin token.
 *  2. Supabase access token — what the mobile app holds in its Supabase
 *     session; verified against Supabase's /auth/v1/user with the service key.
 */
@Injectable()
export class VenueAuthGuard implements CanActivate {
  constructor(
    private readonly auth: AdminAuthService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<any>();
    const identity = await this.resolveIdentity(req);
    if (!identity) throw new UnauthorizedException('Missing or invalid auth token');

    const venueId = await this.resolveVenueId(req);
    if (!venueId) {
      throw new ForbiddenException('Venue could not be resolved for authorization');
    }

    // Platform admin operates every venue.
    if (identity.email && identity.email === this.auth.getAdminEmail()) return true;

    // Supabase tokens carry the auth uid directly (User.id === auth uid in
    // this project); the admin JWT only has the email, so look the user up.
    let userId = identity.userId;
    if (!userId && identity.email) {
      const user = await this.prisma.user.findUnique({ where: { email: identity.email } });
      userId = user?.id;
    }
    if (!userId) throw new ForbiddenException('Caller does not operate this venue');
    const member = await this.prisma.venueMember.findUnique({
      where: { venueId_userId: { venueId, userId } },
    });
    if (!member) throw new ForbiddenException('Caller does not operate this venue');
    return true;
  }

  private async resolveIdentity(req: any): Promise<CallerIdentity | null> {
    const header = req.headers?.authorization as string | undefined;
    if (!header || !header.startsWith('Bearer ')) return null;
    const token = header.slice(7).trim();
    if (!token) return null;

    // 1. Backend admin JWT.
    try {
      const decoded = this.auth.verifyToken(token) as { email?: string };
      return { email: (decoded.email || '').toLowerCase().trim() };
    } catch {
      // Not a backend admin token — fall through to Supabase.
    }

    // 2. Supabase access token.
    const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseKey =
      process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
    if (!supabaseUrl || !supabaseKey) return null;
    try {
      const res = await fetch(`${supabaseUrl.replace(/\/$/, '')}/auth/v1/user`, {
        headers: { apikey: supabaseKey, Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return null;
      const user = (await res.json()) as { id?: string; email?: string };
      if (!user?.id) return null;
      return { email: (user.email || '').toLowerCase().trim(), userId: user.id };
    } catch {
      return null;
    }
  }

  /** venueId comes from the route param (ensure/byVenue), the DTO (POST /),
   *  or the virtual account row itself (GET /:id). */
  private async resolveVenueId(req: any): Promise<string | null> {
    const params = req.params || {};
    if (params.venueId) return String(params.venueId);
    if (params.id) {
      const va = await this.prisma.virtualAccount.findUnique({ where: { id: params.id } });
      return va?.venueId || null;
    }
    const body = req.body || {};
    if (body.venueId) return String(body.venueId);
    return null;
  }
}
