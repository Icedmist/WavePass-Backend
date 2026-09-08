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
  verifyPassword(@Body() body: { email?: string; password: string }) {
    const ok = this.auth.verifyPassword(body.password || '', body.email);
    if (!ok) return { ok: false, role: null };
    const { token, expiresIn } = this.auth.signAdminToken(body.email);
    return { ok: true, role: 'admin', token, expiresIn, email: body.email || undefined };
  }

  @Post('change-password')
  changePassword(@Body() body: { email?: string; currentPassword: string; newPassword: string }) {
    if (!body.currentPassword || !body.newPassword) {
      return { ok: false, error: 'Both current password and new password are required' };
    }
    const success = this.auth.changePassword(body.currentPassword, body.newPassword, body.email);
    if (!success) {
      return { ok: false, error: 'Current password is incorrect' };
    }
    const { token, expiresIn } = this.auth.signAdminToken(body.email);
    return { ok: true, message: 'Password updated successfully', token, expiresIn };
  }

  @Post('update-profile')
  async updateProfile(@Body() body: { email?: string; name?: string; newEmail?: string }) {
    if (body.newEmail) {
      this.auth.updateAdminEmail(body.newEmail);
    }
    const user = await this.admin.updateUserProfile(body.email, body.name, body.newEmail);
    return { ok: true, message: 'Profile updated successfully', user };
  }

  @Post('delete-account')
  async deleteAccount(@Body() body: { email?: string; password: string }) {
    if (!body.password) {
      return { ok: false, error: 'Password is required to delete account' };
    }
    const ok = this.auth.verifyPassword(body.password, body.email);
    if (!ok) {
      return { ok: false, error: 'Incorrect password. Account deletion rejected.' };
    }
    const result = await this.admin.deleteUserAccount(body.email);
    return { ok: true, message: 'Account deleted successfully', result };
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
