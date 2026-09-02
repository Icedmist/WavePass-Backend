import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';
import { MikrotikAdapter } from '../mikrotik/mikrotik.adapter';
import { CreateRouterDto } from './dto/create-router.dto';
import { RouterStatus } from '@prisma/client';

@Injectable()
export class RoutersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mikrotik: MikrotikAdapter,
  ) {}

  async listRouters(venueId?: string) {
    const where = venueId ? { venueId } : {};
    return this.prisma.router.findMany({
      where,
      include: {
        venue: { select: { id: true, name: true, slug: true } },
        _count: { select: { sessions: true, jobs: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getRouterById(id: string) {
    const router = await this.prisma.router.findUnique({
      where: { id },
      include: { venue: true },
    });
    if (!router) throw new NotFoundException(`Router with id ${id} not found`);
    return router;
  }

  async createRouter(dto: CreateRouterDto) {
    const router = await this.prisma.router.create({
      data: {
        venueId: dto.venueId,
        name: dto.name,
        endpoint: dto.endpoint,
        connectionMode: dto.connectionMode,
        rosVersion: dto.rosVersion,
        status: RouterStatus.OFFLINE,
      },
    });

    // Run immediate connectivity check in background
    this.testRouter(router.id).catch(() => {});
    return router;
  }

  async testRouter(id: string) {
    const router = await this.getRouterById(id);
    const user = process.env.MIKROTIK_API_USER || 'admin';
    const pass = process.env.MIKROTIK_API_PASS || '';

    const reachable = await this.mikrotik.testConnection(router.endpoint, user, pass);
    const status = reachable ? RouterStatus.ONLINE : RouterStatus.OFFLINE;

    return this.prisma.router.update({
      where: { id },
      data: {
        status,
        lastSeen: reachable ? new Date() : router.lastSeen,
      },
    });
  }

  async getHealth(id: string) {
    const router = await this.getRouterById(id);
    const reachable = router.status === RouterStatus.ONLINE;
    return {
      id: router.id,
      name: router.name,
      endpoint: router.endpoint,
      status: router.status,
      lastSeen: router.lastSeen,
      reachable,
      timestamp: new Date(),
    };
  }
}
