import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHash, timingSafeEqual } from 'crypto';

@Injectable()
export class AdminAuthService {
  private readonly jwtSecret = process.env.JWT_SECRET || 'wavepass-change-me-jwt';
  // Flag: expiry 2h — confirm if you want 30m (more secure) or 12h (less friction). Using 2h as sensible default.
  private readonly expiresIn = process.env.ADMIN_JWT_EXPIRES_IN || '2h';

  constructor(private readonly jwt: JwtService) {}

  private adminEmail = (process.env.ADMIN_EMAIL || 'talk2icedmist@gmail.com').toLowerCase().trim();
  private runtimePasswordHash?: string;

  verifyPassword(password: string, email?: string): boolean {
    if (email && email.toLowerCase().trim() !== this.adminEmail) return false;
    const hash =
      this.runtimePasswordHash ||
      process.env.ADMIN_PASSWORD_HASH ||
      createHash('sha256').update(process.env.ADMIN_PASSWORD || 'wavepass-change-me').digest('hex');
    const given = createHash('sha256').update(password || '').digest('hex');
    const a = Buffer.from(given, 'utf8');
    const b = Buffer.from(hash, 'utf8');
    return a.length === b.length && timingSafeEqual(a, b);
  }

  async verifyUserOrAdminPassword(password: string, email?: string): Promise<{ ok: boolean; supabaseUserId?: string }> {
    // 1. Check platform admin credentials
    if (this.verifyPassword(password, email)) {
      return { ok: true };
    }

    // 2. Check Supabase Auth credentials for user account
    if (!email || !password) return { ok: false };
    const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseKey =
      process.env.SUPABASE_SERVICE_ROLE_KEY ||
      process.env.SUPABASE_SECRET_KEY ||
      process.env.SUPABASE_PUBLISHABLE_KEY ||
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
    if (!supabaseUrl || !supabaseKey) return { ok: false };

    try {
      const res = await fetch(`${supabaseUrl.replace(/\/$/, '')}/auth/v1/token?grant_type=password`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': supabaseKey,
        },
        body: JSON.stringify({ email: email.toLowerCase().trim(), password }),
      });
      if (res.ok) {
        const data: any = await res.json().catch(() => ({}));
        const userId = data.user?.id;
        return { ok: true, supabaseUserId: userId };
      }
    } catch (_) {}
    return { ok: false };
  }

  changePassword(currentPassword: string, newPassword: string, email?: string): boolean {
    if (!this.verifyPassword(currentPassword, email)) return false;
    this.runtimePasswordHash = createHash('sha256').update(newPassword).digest('hex');
    return true;
  }

  updateAdminEmail(newEmail: string): void {
    if (newEmail && newEmail.includes('@')) {
      this.adminEmail = newEmail.toLowerCase().trim();
    }
  }

  getAdminEmail(): string {
    return this.adminEmail;
  }

  // keep old single-arg signature for cashout compat (no email check)
  verifyAdminPassword(password: string): boolean {
    return this.verifyPassword(password);
  }

  signAdminToken(email?: string): { token: string; expiresIn: string } {
    const payload: any = { role: 'admin', iss: 'wavepass-admin' };
    if (email) payload.email = email.toLowerCase().trim();
    const token = this.jwt.sign(payload, { secret: this.jwtSecret, expiresIn: this.expiresIn as any });
    return { token, expiresIn: this.expiresIn };
  }

  verifyToken(token: string): { role: string } {
    try {
      const decoded = this.jwt.verify(token, { secret: this.jwtSecret }) as any;
      if (decoded.role !== 'admin') throw new UnauthorizedException('Invalid role');
      return decoded;
    } catch {
      throw new UnauthorizedException('Invalid or expired admin token');
    }
  }
}
