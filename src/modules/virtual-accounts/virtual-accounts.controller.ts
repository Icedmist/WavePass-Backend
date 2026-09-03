import { Body, Controller, Get, Param, Post, ValidationPipe } from '@nestjs/common';
import { VirtualAccountsService } from './virtual-accounts.service';
import { CreateVirtualAccountDto } from './dto/create-virtual-account.dto';

@Controller('virtual-accounts')
export class VirtualAccountsController {
  constructor(private readonly va: VirtualAccountsService) {}

  @Post()
  create(@Body(new ValidationPipe({ whitelist: true })) dto: CreateVirtualAccountDto) {
    return this.va.createVirtualAccount(dto);
  }

  @Post('ensure/:venueId')
  ensure(@Param('venueId') venueId: string) {
    return this.va.ensureForVenue(venueId);
  }

  @Get('venue/:venueId')
  byVenue(@Param('venueId') venueId: string) {
    return this.va.getForVenue(venueId);
  }

  @Get(':id')
  byId(@Param('id') id: string) {
    return this.va.getById(id);
  }
}