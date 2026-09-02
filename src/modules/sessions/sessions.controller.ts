import { Controller, Get, Param, Post, Query } from '@nestjs/common';
import { SessionsService } from './sessions.service';

@Controller('sessions')
export class SessionsController {
  constructor(private readonly sessions: SessionsService) {}

  @Get()
  listActive(@Query('venueId') venueId?: string) {
    return this.sessions.listActiveSessions(venueId);
  }

  @Get('active')
  listActiveAlias(@Query('venueId') venueId?: string) {
    return this.sessions.listActiveSessions(venueId);
  }

  @Get(':id')
  getById(@Param('id') id: string) {
    return this.sessions.getSessionById(id);
  }

  @Post(':id/disconnect')
  disconnect(@Param('id') id: string) {
    return this.sessions.disconnectSession(id);
  }
}
