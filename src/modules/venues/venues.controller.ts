import { Body, Controller, Get, Headers, Param, Post, Query } from '@nestjs/common';
import { VenuesService } from './venues.service';
import { CreateVenueDto } from './dto/create-venue.dto';

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
}
