import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { PortalService } from './portal.service';
import { InitPaymentDto } from './dto/init-payment.dto';

@Controller('portal')
export class PortalController {
  constructor(private readonly portal: PortalService) {}

  @Get('plans')
  plans(@Query('venueId') venueId?: string) {
    return this.portal.getPortalPlans(venueId);
  }

  @Post('init-payment')
  initPayment(@Body() dto: InitPaymentDto) {
    return this.portal.initPayment(dto);
  }

  @Post('simulate-payment')
  simulatePayment(@Body() body: { mac: string; planId: string; venueId?: string }) {
    return this.portal.simulatePayment(body);
  }

  @Get('landing')
  landing(@Query('mac') mac: string, @Query('ip') ip?: string) {
    if (!mac) return { hasPaid: false, walledGardenOpen: true, message: 'mac required — walled garden open for portal' };
    return this.portal.getLandingStatus(mac, ip);
  }

  @Get('sessions/:mac')
  sessionStatus(@Param('mac') mac: string) {
    return this.portal.getSessionStatus(mac);
  }
}
