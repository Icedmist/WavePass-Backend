import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';
import { CreateVenueDto } from './dto/create-venue.dto';

@Injectable()
export class VenuesService {
  constructor(private readonly prisma: PrismaService) {}

  async listVenues() {
    return this.prisma.venue.findMany({
      include: {
        routers: { select: { id: true, name: true, status: true, lastSeen: true } },
        _count: { select: { plans: true, sessions: true, orders: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getVenueById(id: string) {
    const venue = await this.prisma.venue.findUnique({
      where: { id },
      include: {
        routers: true,
        plans: { where: { active: true } },
      },
    });
    if (!venue) throw new NotFoundException(`Venue with id ${id} not found`);
    return venue;
  }

  async getVenueBySlug(slug: string) {
    const venue = await this.prisma.venue.findUnique({
      where: { slug },
      include: {
        routers: true,
        plans: { where: { active: true } },
      },
    });
    if (!venue) throw new NotFoundException(`Venue with slug ${slug} not found`);
    return venue;
  }

  async getVenueByHost(host: string) {
    const clean = host.split(':')[0].toLowerCase();
    // host like my-venue.nexawavepass.com or localhost:3000
    const parts = clean.split('.');
    // skip bare domains and localhost
    if (clean === 'localhost' || clean === '127.0.0.1' || parts.length < 3) {
      return null;
    }
    const sub = parts[0];
    if (!sub || sub === 'www' || sub === 'api' || sub === 'admin') return null;
    return this.getVenueBySlug(sub).catch(() => null);
  }

  async createVenue(dto: CreateVenueDto) {
    const slug = dto.slug.toLowerCase().trim();
    const existing = await this.prisma.venue.findUnique({ where: { slug } });
    if (existing) throw new ConflictException(`Venue slug ${slug} already exists`);

    return this.prisma.venue.create({
      data: {
        name: dto.name,
        slug,
        timezone: dto.timezone || 'Africa/Lagos',
        currency: dto.currency || 'NGN',
        logoUrl: dto.logoUrl,
      },
    });
  }

  async updateVenue(id: string, dto: any) {
    const venue = await this.prisma.venue.findUnique({ where: { id } });
    if (!venue) throw new NotFoundException(`Venue ${id} not found`);
    if (dto.slug) {
      const slug = dto.slug.toLowerCase().trim();
      if (!/^[a-z0-9-]+$/.test(slug)) throw new ConflictException('Invalid slug format');
      const exists = await this.prisma.venue.findUnique({ where: { slug } });
      if (exists && exists.id !== id) throw new ConflictException(`Slug ${slug} already taken`);
      dto.slug = slug;
    }
    return this.prisma.venue.update({ where: { id }, data: dto });
  }

  async getDefaultVenue() {
    let venue = await this.prisma.venue.findFirst({
      include: { routers: true, plans: { where: { active: true } } },
    });
    if (!venue) {
      // Auto-bootstrap a default venue for seamless local demo and captive portal usage
      venue = await this.prisma.venue.create({
        data: {
          name: 'WavePass Default Venue',
          slug: 'default',
          timezone: 'Africa/Lagos',
          currency: 'NGN',
          logoUrl: 'https://nexawavepass.com/logo.png',
        },
        include: { routers: true, plans: { where: { active: true } } },
      });
    }
    return venue;
  }
}
