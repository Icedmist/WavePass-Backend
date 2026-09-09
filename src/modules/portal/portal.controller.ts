import { Body, Controller, Get, Param, Post, Query, Req, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
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

  @Throttle({ portal: { ttl: 60000, limit: 20 } })
  @Post('init-payment')
  initPayment(@Body() dto: InitPaymentDto) {
    return this.portal.initPayment(dto);
  }

  @Throttle({ portal: { ttl: 60000, limit: 20 } })
  @Post('simulate-payment')
  simulatePayment(@Body() body: { mac: string; planId: string; venueId?: string }) {
    return this.portal.simulatePayment(body);
  }

  @Get('landing')
  landing(@Query('mac') mac?: string, @Query('ip') ip?: string) {
    if (!mac && !ip) return { hasPaid: false, walledGardenOpen: true, message: 'Open via hotspot login (http://example.com) so we can detect your device, or enter voucher code.' };
    return this.portal.getLandingStatus(mac, ip);
  }

  // Captive portal intercept — MikroTik redirects any unauth HTTP here;
  // we bounce the device straight to the venue store subdomain with mac/ip/link-orig
  // Pass ?venue=<slug> or ?routerId=<id> so unpaid devices land on slug.nexawavepass.com, not the generic homepage
  @Get('captive')
  async captive(@Query('mac') mac: string, @Query('ip') ip: string, @Query('link-orig') linkOrig: string, @Query('username') username: string, @Query('venue') venue: string, @Query('routerId') routerId: string, @Res() res: FastifyReply) {
    const target = await this.portal.getCaptiveRedirect(mac, ip, linkOrig, username, venue, routerId);
    return res.status(302).header('Location', target).send();
  }

  @Get('login')
  async loginRedirect(@Query('mac') mac: string, @Query('ip') ip: string, @Query('link-orig') linkOrig: string, @Query('username') username: string, @Query('venue') venue: string, @Query('routerId') routerId: string, @Res() res: FastifyReply) {
    const target = await this.portal.getCaptiveRedirect(mac, ip, linkOrig, username, venue, routerId);
    return res.status(302).header('Location', target).send();
  }

  @Get('sessions/:mac')
  sessionStatus(@Param('mac') mac: string) {
    return this.portal.getSessionStatus(mac);
  }
}
