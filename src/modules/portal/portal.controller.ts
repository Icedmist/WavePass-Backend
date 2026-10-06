import { Body, Controller, Get, Param, Post, Query, Req, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { FastifyReply, FastifyRequest } from 'fastify';
import { PortalService } from './portal.service';
import { InitPaymentDto } from './dto/init-payment.dto';

@Controller('portal')
export class PortalController {
  constructor(private readonly portal: PortalService) {}

  @Get('plans')
  plans(
    @Query('venueId') venueId?: string,
    @Query('venue') venue?: string,
    @Query('v') v?: string,
    @Query('slug') slug?: string,
  ) {
    return this.portal.getPortalPlans(venueId || venue || v || slug);
  }

  @Get('info')
  venueInfo(
    @Query('venue') venue?: string,
    @Query('venueId') venueId?: string,
    @Query('v') v?: string,
    @Query('slug') slug?: string,
  ) {
    return this.portal.getPortalVenueInfo(venue || venueId || v || slug);
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

  @Throttle({ portal: { ttl: 60000, limit: 15 } })
  @Post('transfer-request')
  transferRequest(@Body() body: {
    venueSlug?: string;
    venueId?: string;
    mac: string;
    planId: string;
    senderName?: string;
    amountMinor?: number;
    bankAccount?: string;
    notes?: string;
  }) {
    return this.portal.submitTransferRequest(body);
  }

  @Throttle({ portal: { ttl: 60000, limit: 30 } })
  @Post('approve-access')
  approveAccess(@Body() body: {
    venueId: string;
    orderId?: string;
    mac: string;
    planId?: string;
    reference?: string;
  }) {
    return this.portal.approveAccess(body);
  }

  @Get('retrieve-voucher')
  retrieveVoucher(
    @Query('mac') mac?: string,
    @Query('q') q?: string,
    @Query('query') query?: string,
    @Query('venue') venue?: string,
    @Query('venueId') venueId?: string,
    @Query('phone') phone?: string,
    @Query('reference') reference?: string,
    @Query('sender') sender?: string,
  ) {
    const effectiveQuery = q || query || phone || reference || sender;
    const effectiveVenue = venueId || venue;
    return this.portal.retrieveVoucher({
      mac,
      q: effectiveQuery,
      venueId: effectiveVenue,
      phone,
      reference,
      sender,
    });
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

  @Get('active-session')
  activeSession(
    @Query('mac') mac?: string,
    @Query('ip') ip?: string,
    @Query('reference') reference?: string,
  ) {
    return this.portal.getDeviceActiveAccess(mac, ip, reference);
  }

  @Get('device/:mac/active-voucher')
  deviceActiveVoucher(@Param('mac') mac: string) {
    return this.portal.getDeviceActiveAccess(mac);
  }

  @Get('sessions/:mac')
  sessionStatus(@Param('mac') mac: string) {
    return this.portal.getSessionStatus(mac);
  }

  @Get('router-sync')
  async routerSync(
    @Query('venue') venueSlug?: string,
    @Query('venueId') venueId?: string,
    @Query('format') format?: string,
    @Res() res?: FastifyReply,
  ) {
    const result = await this.portal.generateRouterSyncScript(venueSlug, venueId, format);
    if (format === 'json') {
      return res?.status(200).send(result);
    }
    return res?.status(200).header('Content-Type', 'text/plain; charset=utf-8').send(result);
  }
}
