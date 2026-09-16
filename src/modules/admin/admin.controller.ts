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

  @Get('profile')
  async getProfile(@Query('email') email?: string) {
    const targetEmail = (email || this.auth.getAdminEmail()).toLowerCase().trim();
    const user = await this.admin.getUserProfile(targetEmail);
    return { ok: true, email: targetEmail, user: user || { email: targetEmail, name: 'Venue Owner' } };
  }

  @Get('update-profile')
  async getUpdateProfile(@Query('email') email?: string) {
    const targetEmail = (email || this.auth.getAdminEmail()).toLowerCase().trim();
    const user = await this.admin.getUserProfile(targetEmail);
    return {
      ok: true,
      email: targetEmail,
      user: user || { email: targetEmail, name: 'Venue Owner' },
      message: 'Admin profile endpoint. Use POST with { email, name, newEmail } to update profile details.',
    };
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
    const check = await this.auth.verifyUserOrAdminPassword(body.password, body.email);
    if (!check.ok) {
      return { ok: false, error: 'Incorrect password. Account deletion rejected.' };
    }
    const result = await this.admin.deleteUserAccount(body.email, check.supabaseUserId);
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

  // ── Fleet & System Health ────────────────────────────────────────────────

  @Get('fleet')
  fleet() {
    return this.admin.getFleetOverview();
  }

  @Get('system-health')
  systemHealth() {
    return this.admin.getSystemHealth();
  }

  // ── Audits Engine ────────────────────────────────────────────────────────

  @Get('audits')
  getAudits(@Query('category') category?: string, @Query('limit') limit?: string) {
    return this.admin.getAuditLogs(category, limit ? parseInt(limit, 10) : 100);
  }

  @Post('audits')
  logAudit(@Body() body: { action: string; category?: string; actor?: string; details?: any; status?: string }) {
    return this.admin.logAudit(body);
  }

  // ── Activation Codes ─────────────────────────────────────────────────────

  @Get('activation-codes')
  listActivationCodes() {
    return this.admin.listActivationCodes();
  }

  @Post('activation-codes/generate')
  generateActivationCodes(
    @Body() body: { count?: number; note?: string; quota?: number; createdBy?: string; expiresAt?: string; venueIds?: string[] },
  ) {
    return this.admin.generateActivationCodes(body.count, body.note, body.quota, body.createdBy, body.expiresAt, body.venueIds);
  }

  @Post('activation-codes/authorize')
  authorizeActivationCode(@Body() body: { code: string; status?: 'AUTHORIZED' | 'REVOKED' }) {
    return this.admin.authorizeActivationCode(body.code, body.status || 'AUTHORIZED');
  }

  @Get('activation-codes/check/:email')
  checkActivation(@Param('email') email: string) {
    return this.admin.checkAccountActivation(email);
  }

  @Post('activation-codes/redeem')
  redeemActivationCode(@Body() body: { code: string; email: string; venueId?: string }) {
    return this.admin.redeemActivationCode(body.code, body.email, body.venueId);
  }
}

