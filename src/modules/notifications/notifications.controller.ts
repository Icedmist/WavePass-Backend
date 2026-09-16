import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { NotificationsService } from './notifications.service';

@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  list(@Query('venueId') venueId: string, @Query('unreadOnly') unreadOnly?: string) {
    return this.notifications.listByVenue(venueId, unreadOnly === 'true');
  }

  @Post()
  create(@Body() body: { venueId: string; title: string; body: string; type?: any; amountMinor?: number; reference?: string }) {
    return this.notifications.create(body);
  }

  @Patch(':id/read')
  markRead(@Param('id') id: string) {
    return this.notifications.markRead(id);
  }

  @Post('venue/:venueId/read-all')
  markAllRead(@Param('venueId') venueId: string) {
    return this.notifications.markAllRead(venueId);
  }
}
