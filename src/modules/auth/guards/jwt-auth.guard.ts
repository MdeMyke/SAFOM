import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { AuthService } from '../auth.service';

type RequestWithHeaders = {
  headers: Record<string, string | string[] | undefined>;
};

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly authService: AuthService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<RequestWithHeaders>();
    const authHeader = req.headers.authorization;
    const token = typeof authHeader === 'string' ? authHeader.replace(/^Bearer\s+/i, '') : undefined;
    return this.authService.validateToken(token);
  }
}

