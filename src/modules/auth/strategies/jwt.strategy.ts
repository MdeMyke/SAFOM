import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { RbacService } from '../../rbac/rbac.service';
import type { RequestUser } from '../../rbac/types/rbac.types';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(private readonly rbac: RbacService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: process.env.JWT_ACCESS_SECRET ?? process.env.JWT_SECRET ?? 'dev-secret-change-me',
    });
  }

  async validate(payload: { sub?: number }): Promise<RequestUser> {
    const userId = Number(payload.sub);
    const permissions = Number.isFinite(userId) ? await this.rbac.getPermissionsByUserId(userId) : [];
    return { id: userId, permissions };
  }
}

