import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';
import { MikrotikAdapter } from '../mikrotik/mikrotik.adapter';
import { SessionStatus } from '@prisma/client';

@Injectable()
export class SessionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mikrotik: MikrotikAdapter,
  ) {}

  async listActiveSessions(venueId?: string) {
    const where: any = { status: SessionStatus.ACTIVE };
    if (venueId) where.venueId = venueId;

    return this.prisma.session.findMany({
      where,
      include: {
        venue: { select: { id: true, name: true } },
        router: { select: { id: true, name: true, endpoint: true } },
        voucher: { select: { id: true, codeHash: true } },
      },
      orderBy: { startedAt: 'desc' },
    });
  }

  async getSessionById(id: string) {
    const session = await this.prisma.session.findUnique({
      where: { id },
      include: { venue: true, router: true, voucher: true },
    });
    if (!session) throw new NotFoundException(`Session ${id} not found`);
    return session;
  }

  async disconnectSession(id: string) {
    const session = await this.getSessionById(id);
    if (session.status !== SessionStatus.ACTIVE) {
      return { ok: true, message: 'Session already inactive', session };
    }

    // Terminate on router if MAC or username is known
    const targetUser = session.mac || session.deviceId;
    if (targetUser) {
      try {
        await this.mikrotik.removeHotspotUser(
          session.router.endpoint,
          {
            username: process.env.MIKROTIK_API_USER || 'admin',
            password: process.env.MIKROTIK_API_PASS || '',
          },
          targetUser,
        );
      } catch (err) {
        // Router may already have expired or dropped the user
      }
    }

    const updated = await this.prisma.session.update({
      where: { id },
      data: {
        status: SessionStatus.ENDED,
        endedAt: new Date(),
      },
    });

    return { ok: true, session: updated };
  }
}
