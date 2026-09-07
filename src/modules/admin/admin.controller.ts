import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AdminService } from './admin.service';
import { AdminAuthService } from './admin-auth.service';
import { AdminAuthGuard } from './admin-auth.guard';

@Throttle({ strict: { ttl: 60000, limit: 10 } })
@Controller('admin')
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly auth: AdminAuthService,
  ) {}

  @Post('verify-password')
  verifyPassword(@Body() body: { password: string }) {
    const ok = this.auth.verifyPassword(body.password || '');
    if (!ok) return { ok: false, role: null };
    const { token, expiresIn } = this.auth.signAdminToken();
    return { ok: true, role: 'admin', token, expiresIn };
  }

  @UseGuards(AdminAuthGuard)
  @Get('stats')
  stats() {
    return this.admin.getStats();
  }

  @UseGuards(AdminAuthGuard)
  @Get('webhook-logs')
  webhookLogs(@Query('limit') limit?: string) {
    return this.admin.getWebhookLogs(limit ? parseInt(limit, 10) : 50);
  }

  @UseGuards(AdminAuthGuard)
  @Post('reconcile')
  reconcile(@Query('venueId') venueId?: string) {
    return this.admin.reconcile(venueId);
  }

  @UseGuards(AdminAuthGuard)
  @Post('cleanup')
  cleanup(@Query('venueId') venueId?: string) {
    return this.admin.cleanup(venueId);
  }

  @UseGuards(AdminAuthGuard)
  @Get('verify/:reference')
  verifyReference(@Param('reference') reference: string) {
    return this.admin.verifyReference(reference);
  }
}
