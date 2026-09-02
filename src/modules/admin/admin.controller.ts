import { Controller, Get, Param, Post, Query } from '@nestjs/common';
import { AdminService } from './admin.service';

@Controller('admin')
export class AdminController {
  constructor(private readonly admin: AdminService) {}

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
