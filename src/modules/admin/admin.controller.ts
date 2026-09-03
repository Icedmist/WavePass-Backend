import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { createHash, timingSafeEqual } from 'crypto';
import { AdminService } from './admin.service';

@Controller('admin')
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Post('verify-password')
  verifyPassword(@Body() body: { password: string }) {
    const hash =
      process.env.ADMIN_PASSWORD_HASH ||
      createHash('sha256').update(process.env.ADMIN_PASSWORD || 'wavepass-change-me').digest('hex');
    const given = createHash('sha256').update(body.password || '').digest('hex');
    const a = Buffer.from(given, 'utf8');
    const b = Buffer.from(hash, 'utf8');
    const ok = a.length === b.length && timingSafeEqual(a, b);
    return { ok, role: ok ? 'admin' : null };
  }

  @Get('stats')
  stats() {
    return this.admin.getStats();
  }

  @Get('webhook-logs')
  webhookLogs(@Query('limit') limit?: string) {
    return this.admin.getWebhookLogs(limit ? parseInt(limit, 10) : 50);
  }

  @Post('reconcile')
  reconcile(@Query('venueId') venueId?: string) {
    return this.admin.reconcile(venueId);
  }

  @Post('cleanup')
  cleanup(@Query('venueId') venueId?: string) {
    return this.admin.cleanup(venueId);
  }

  @Get('verify/:reference')
  verifyReference(@Param('reference') reference: string) {
    return this.admin.verifyReference(reference);
  }
}
