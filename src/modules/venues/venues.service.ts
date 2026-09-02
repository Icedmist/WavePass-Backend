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

  async createVenue(dto: CreateVenueDto) {
    const existing = await this.prisma.venue.findUnique({ where: { slug: dto.slug } });
    if (existing) throw new ConflictException(`Venue slug ${dto.slug} already exists`);

    return this.prisma.venue.create({
      data: {
        name: dto.name,
        slug: dto.slug,
        timezone: dto.timezone || 'Africa/Lagos',
        currency: dto.currency || 'NGN',
        logoUrl: dto.logoUrl,
      },
    });
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
        },
        include: { routers: true, plans: { where: { active: true } } },
      });
    }
    return venue;
  }
}
