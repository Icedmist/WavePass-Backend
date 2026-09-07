import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { AdminAuthService } from './admin-auth.service';

@Injectable()
export class AdminAuthGuard implements CanActivate {
  constructor(private readonly auth: AdminAuthService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<any>();
    const header = req.headers?.authorization as string | undefined;
    if (!header || !header.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing admin token');
    }
    const token = header.slice(7).trim();
    if (!token) throw new UnauthorizedException('Missing admin token');
    this.auth.verifyToken(token);
    return true;
  }
}
