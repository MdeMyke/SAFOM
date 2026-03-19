import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PERMISOS_KEY } from '../constants/rbac.constants';
import { RequestUser } from '../types/rbac.types';

type RequestWithUser = {
  user?: RequestUser;
  headers: Record<string, string | string[] | undefined>;
};

@Injectable()
export class PermisosGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const permisosRequeridos =
      this.reflector.getAllAndOverride<string[]>(PERMISOS_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? [];

    if (permisosRequeridos.length === 0) {
      return true;
    }

    const req = context.switchToHttp().getRequest<RequestWithUser>();
    const user = req.user ?? this.hydrateUserFromHeaders(req);

    if (!user) {
      throw new UnauthorizedException('Usuario no autenticado.');
    }

    const tieneTodos = permisosRequeridos.every((permiso) =>
      user.permissions.includes(permiso),
    );

    if (!tieneTodos) {
      throw new ForbiddenException('No tienes permisos para esta acción.');
    }

    return true;
  }

  private hydrateUserFromHeaders(req: RequestWithUser): RequestUser | null {
    const rawPermisos = req.headers['x-permisos'] ?? req.headers['x-permissions'];
    if (!rawPermisos || Array.isArray(rawPermisos)) {
      return null;
    }

    const permissions = rawPermisos
      .split(',')
      .map((permiso) => permiso.trim())
      .filter(Boolean);

    const user: RequestUser = {
      id: 0,
      permissions,
    };
    req.user = user;
    return user;
  }
}

