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
    const where: Record<string, unknown> = { active: true };
    if (venueId) where.venueId = venueId;

    const plans = await this.prisma.plan.findMany({
      where,
      orderBy: { priceMinor: 'asc' },
    });

    return plans.map((p) => this.formatPlan(p));
  }

  async getPlanById(id: string) {
    // 1. Direct find
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
        active: true,
      },
    });
    if (plan) return this.formatPlan(plan);

    // 4. Fallback to first active plan
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
