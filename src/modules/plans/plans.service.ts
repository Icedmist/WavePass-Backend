import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';
import { CreatePlanDto } from './dto/create-plan.dto';
import { UpdatePlanDto } from './dto/update-plan.dto';

function formatDuration(seconds: number): string {
  if (seconds >= 86400) return `${Math.floor(seconds / 86400)}d`;
  if (seconds >= 3600) return `${Math.floor(seconds / 3600)}h`;
  if (seconds >= 60) return `${Math.floor(seconds / 60)}m`;
  return `${seconds}s`;
}

function deriveProfile(seconds: number): string {
  const duration = formatDuration(seconds);
  return `profile_${duration}`;
}

@Injectable()
export class PlansService {
  constructor(private readonly prisma: PrismaService) {}

  async listPlans(venueId?: string) {
    let resolvedVenueId = venueId;
    if (venueId && venueId.trim() !== '' && venueId !== 'null' && venueId !== 'undefined' && venueId.trim() !== 'venue') {
      try {
        const venue = await this.prisma.venue.findFirst({
          where: {
            OR: [
              { id: venueId.trim() },
              { slug: venueId.toLowerCase().trim() },
            ],
          },
        });
        if (venue) {
          resolvedVenueId = venue.id;
        }
      } catch (_) {}
    } else {
      resolvedVenueId = undefined;
    }

    const where: Record<string, unknown> = { active: true };
    if (resolvedVenueId) where.venueId = resolvedVenueId;

    let plans = await this.prisma.plan.findMany({
      where,
      orderBy: { priceMinor: 'asc' },
    });

    if (plans.length === 0 && resolvedVenueId) {
      plans = await this.ensureDefaultPlans(resolvedVenueId);
    }

    return plans.map((p) => this.formatPlan(p));
  }

  async ensureDefaultPlans(venueId: string) {
    const existing = await this.prisma.plan.findMany({
      where: { venueId, active: true },
      orderBy: { priceMinor: 'asc' },
    });
    if (existing.length > 0) return existing;

    const defaultTemplates = [
      { name: '1 Hour Surf', priceMinor: 20000, durationSeconds: 3600, rateLimit: 'profile_1h', description: 'High-speed unlimited access for 1 hour' },
      { name: '12 Hours Pass', priceMinor: 80000, durationSeconds: 43200, rateLimit: 'profile_12h', description: 'Extended full-day work session for 12 hours' },
      { name: '24 Hours Pass', priceMinor: 120000, durationSeconds: 86400, rateLimit: 'profile_24h', description: 'Full day and night uninterrupted access for 24 hours' },
      { name: '7 Days Pass', priceMinor: 350000, durationSeconds: 604800, rateLimit: 'profile_7d', description: 'Weekly pass for consistent high-speed connectivity' },
    ];

    try {
      for (const t of defaultTemplates) {
        await this.prisma.plan.create({
          data: {
            venueId,
            name: t.name,
            description: t.description,
            priceMinor: t.priceMinor,
            durationSeconds: t.durationSeconds,
            rateLimit: t.rateLimit,
            active: true,
          },
        });
      }
    } catch (_) {}

    return this.prisma.plan.findMany({
      where: { venueId, active: true },
      orderBy: { priceMinor: 'asc' },
    });
  }

  async getPlanById(id: string, venueId?: string) {
    let resolvedVenueId = venueId;
    if (venueId && venueId.trim() !== '' && venueId !== 'null' && venueId !== 'undefined' && venueId.trim() !== 'venue') {
      try {
        const v = await this.prisma.venue.findFirst({
          where: {
            OR: [
              { id: venueId.trim() },
              { slug: venueId.toLowerCase().trim() },
            ],
          },
        });
        if (v) resolvedVenueId = v.id;
      } catch (_) {}
    } else {
      resolvedVenueId = undefined;
    }

    if (resolvedVenueId) {
      // 1. Direct find within venue
      let plan = await this.prisma.plan.findFirst({
        where: { id, venueId: resolvedVenueId, active: true },
      });
      if (plan) return this.formatPlan(plan);

      // 2. Alias mapping within venue
      const aliasDurationMap: Record<string, number> = {
        plan_1h: 3600,
        plan_1hr: 3600,
        plan_12h: 43200,
        plan_12hr: 43200,
        plan_24h: 86400,
        plan_24hr: 86400,
        plan_1d: 86400,
        plan_7d: 604800,
      };
      if (aliasDurationMap[id]) {
        plan = await this.prisma.plan.findFirst({
          where: { venueId: resolvedVenueId, durationSeconds: aliasDurationMap[id], active: true },
        });
        if (plan) return this.formatPlan(plan);
      }
    }

    // 1. Direct find global
    let plan = await this.prisma.plan.findUnique({ where: { id } });
    if (plan) return this.formatPlan(plan);

    // 2. Common alias mapping (e.g. plan_1h -> plan_1hr, plan_24h -> plan_24hr)
    const aliasMap: Record<string, string> = {
      plan_1h: 'plan_1hr',
      plan_12h: 'plan_12hr',
      plan_24h: 'plan_24hr',
      plan_1d: 'plan_24hr',
      plan_7d: 'plan_7d',
    };
    if (aliasMap[id]) {
      plan = await this.prisma.plan.findUnique({ where: { id: aliasMap[id] } });
      if (plan) return this.formatPlan(plan);
    }

    // 3. Match by name or partial ID
    plan = await this.prisma.plan.findFirst({
      where: {
        OR: [
          { id: { contains: id, mode: 'insensitive' } },
          { name: { contains: id, mode: 'insensitive' } },
        ],
        ...(resolvedVenueId ? { venueId: resolvedVenueId } : {}),
        active: true,
      },
    });
    if (plan) return this.formatPlan(plan);

    // 4. Fallback to first active plan in venue if specified
    if (resolvedVenueId) {
      plan = await this.prisma.plan.findFirst({
        where: { venueId: resolvedVenueId, active: true },
        orderBy: { priceMinor: 'asc' },
      });
      if (plan) return this.formatPlan(plan);
    }

    // 5. Fallback to first active plan globally
    plan = await this.prisma.plan.findFirst({
      where: { active: true },
      orderBy: { priceMinor: 'asc' },
    });
    if (plan) return this.formatPlan(plan);

    throw new NotFoundException(`Plan with id ${id} not found`);
  }

  async createPlan(dto: CreatePlanDto) {
    const plan = await this.prisma.plan.create({
      data: {
        venueId: dto.venueId,
        name: dto.name,
        description: dto.description,
        priceMinor: dto.priceMinor,
        durationSeconds: dto.durationSeconds,
        dataLimitBytes: dto.dataLimitBytes ? BigInt(dto.dataLimitBytes) : null,
        rateLimit: dto.rateLimit,
        simultaneousDevices: dto.simultaneousDevices ?? 1,
        mode: dto.mode ?? 'ELAPSED',
        active: dto.active ?? true,
        version: 1,
      },
    });
    return this.formatPlan(plan);
  }

  async updatePlan(id: string, dto: UpdatePlanDto) {
    const current = await this.prisma.plan.findUnique({ where: { id } });
    if (!current) throw new NotFoundException(`Plan with id ${id} not found`);

    const isVersionBump =
      (dto.priceMinor && dto.priceMinor !== current.priceMinor) ||
      (dto.durationSeconds && dto.durationSeconds !== current.durationSeconds);

    const updated = await this.prisma.plan.update({
      where: { id },
      data: {
        ...dto,
        dataLimitBytes: dto.dataLimitBytes !== undefined ? (dto.dataLimitBytes ? BigInt(dto.dataLimitBytes) : null) : undefined,
        version: isVersionBump ? current.version + 1 : current.version,
      },
    });

    return this.formatPlan(updated);
  }

  async deactivatePlan(id: string) {
    await this.getPlanById(id);
    return this.prisma.plan.update({
      where: { id },
      data: { active: false },
    });
  }

  private formatPlan(p: any) {
    const duration = formatDuration(p.durationSeconds);
    const profile = deriveProfile(p.durationSeconds);
    return {
      id: p.id,
      venueId: p.venueId,
      name: p.name,
      description: p.description,
      priceMinor: p.priceMinor,
      priceNGN: Math.round(p.priceMinor / 100),
      amountKobo: p.priceMinor,
      duration,
      durationSeconds: p.durationSeconds,
      limitUptime: duration,
      profile,
      dataLimitBytes: p.dataLimitBytes ? p.dataLimitBytes.toString() : null,
      rateLimit: p.rateLimit,
      simultaneousDevices: p.simultaneousDevices,
      mode: p.mode,
      version: p.version,
      active: p.active,
      createdAt: p.createdAt,
    };
  }
}
