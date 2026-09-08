import { Body, Controller, Get, Headers, Param, Patch, Post, Query } from '@nestjs/common';
import { VenuesService } from './venues.service';
import { CreateVenueDto } from './dto/create-venue.dto';
import { UpdateVenueDto } from './dto/update-venue.dto';

@Controller('venues')
export class VenuesController {
  constructor(private readonly venues: VenuesService) {}

  @Get()
  list() {
    return this.venues.listVenues();
  }

  @Get('by-host')
  byHost(@Headers('host') host: string, @Query('host') qHost?: string) {
    return this.venues.getVenueByHost(qHost || host || '');
  }

  @Get('by-subdomain/:subdomain')
  bySubdomain(@Param('subdomain') subdomain: string) {
    return this.venues.getVenueBySlug(subdomain);
  }

  @Get('check-slug/:slug')
  checkSlug(@Param('slug') slug: string, @Query('venueId') venueId?: string) {
    return this.venues.checkSlugAvailability(slug, venueId);
  }

  @Get('default')
  getDefault() {
    return this.venues.getDefaultVenue();
  }

  @Get(':id')
  getById(@Param('id') id: string) {
    return this.venues.getVenueById(id);
  }

  @Post()
  create(@Body() dto: CreateVenueDto) {
    return this.venues.createVenue(dto);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateVenueDto) {
    return this.venues.updateVenue(id, dto);
  }
}
