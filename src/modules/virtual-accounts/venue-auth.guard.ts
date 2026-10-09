import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { AdminAuthService } from '../admin/admin-auth.service';
import { PrismaService } from '../../common/prisma.service';

/**
 * Venue-scoped auth for virtual-account endpoints. Follows the same Bearer
 * token pattern as AdminAuthGuard (admin.controller.ts), then additionally
 * verifies the caller actually operates the venue: the platform admin
 * operates every venue, any other caller must be a VenueMember of it.
 */
@Injectable()
export class VenueAuthGuard implements CanActivate {
  constructor(
    private readonly auth: AdminAuthService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<any>();
    const header = req.headers?.authorization as string | undefined;
    if (!header || !header.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing admin token');
    }
    const token = header.slice(7).trim();
    if (!token) throw new UnauthorizedException('Missing admin token');
    const decoded = this.auth.verifyToken(token) as { email?: string };
    const email = (decoded.email || '').toLowerCase().trim();

    const venueId = await this.resolveVenueId(req);
    if (!venueId) {
      throw new ForbiddenException('Venue could not be resolved for authorization');
    }

    if (email && email === this.auth.getAdminEmail()) return true;

    const user = email ? await this.prisma.user.findUnique({ where: { email } }) : null;
    if (!user) throw new ForbiddenException('Caller does not operate this venue');
    const member = await this.prisma.venueMember.findUnique({
      where: { venueId_userId: { venueId, userId: user.id } },
    });
    if (!member) throw new ForbiddenException('Caller does not operate this venue');
    return true;
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
