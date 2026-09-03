import { Body, Controller, Get, Param, Post, Query, Req, Res } from '@nestjs/common';
import { FastifyReply, FastifyRequest } from 'fastify';
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

  // Captive portal intercept — MikroTik redirects any unauth HTTP here;
  // we bounce the device straight to the WavePass web landing with mac/ip/link-orig
  @Get('captive')
  async captive(@Query('mac') mac: string, @Query('ip') ip: string, @Query('link-orig') linkOrig: string, @Query('username') username: string, @Res() res: FastifyReply) {
    const target = await this.portal.getCaptiveRedirect(mac, ip, linkOrig, username);
    return res.status(302).header('Location', target).send();
  }

  @Get('login')
  async loginRedirect(@Query('mac') mac: string, @Query('ip') ip: string, @Query('link-orig') linkOrig: string, @Query('username') username: string, @Res() res: FastifyReply) {
    const target = await this.portal.getCaptiveRedirect(mac, ip, linkOrig, username);
    return res.status(302).header('Location', target).send();
  }

  @Get('sessions/:mac')
  sessionStatus(@Param('mac') mac: string) {
    return this.portal.getSessionStatus(mac);
  }
}
