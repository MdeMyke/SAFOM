import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../../prisma/prisma.service';
import { RbacService } from '../rbac/rbac.service';
import { randomBytes } from 'crypto';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly rbac: RbacService,
  ) {}

  async login(input: {
    email: string;
    password: string;
    rememberMe: boolean;
    ipAddress?: string;
    userAgent?: string;
  }) {
    const email = (input.email ?? '').trim().toLowerCase();
    if (!email || !input.password) {
      throw new UnauthorizedException('Credenciales inválidas');
    }

    const user = await this.prisma.user.findUnique({
      where: { correo: email },
      select: {
        id: true,
        correo: true,
        nombre: true,
        cedula: true,
        telefono: true,
        password: true,
        deletedAt: true,
      },
    });

    if (!user || user.deletedAt) {
      throw new UnauthorizedException('Credenciales inválidas');
    }

    const passwordOk = await this.verifyPassword(user.password, input.password, user.id);
    if (!passwordOk) {
      throw new UnauthorizedException('Credenciales inválidas');
    }

    const permissions = await this.rbac.getPermissionsByUserId(user.id);
    const accessToken = await this.signAccessToken(user.id);

    const refreshExpiresDays = input.rememberMe ? 30 : 7;
    const refreshToken = await this.issueRefreshToken({
      userId: user.id,
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
      expiresInDays: refreshExpiresDays,
    });

    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    return {
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        correo: user.correo,
        nombre: user.nombre,
        cedula: user.cedula,
        telefono: user.telefono ?? '',
        permissions,
      },
    };
  }

  async refresh(input: { refreshToken: string; ipAddress?: string; userAgent?: string }) {
    if (!input.refreshToken) throw new UnauthorizedException('Credenciales inválidas');

    const session = await this.prisma.session.findFirst({
      where: { refreshToken: input.refreshToken },
      select: {
        id: true,
        userId: true,
        expiresAt: true,
      },
    });

    if (!session?.userId) {
      throw new UnauthorizedException('Sesión inválida');
    }

    if (session.expiresAt.getTime() <= Date.now()) {
      await this.prisma.session.deleteMany({ where: { id: session.id } });
      throw new UnauthorizedException('Sesión expirada');
    }

    // Rotación simple: borrar el token usado y emitir uno nuevo.
    await this.prisma.session.deleteMany({ where: { id: session.id } });

    const accessToken = await this.signAccessToken(session.userId);
    const refreshToken = await this.issueRefreshToken({
      userId: session.userId,
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
      expiresInDays: 30,
    });

    return { accessToken, refreshToken };
  }

  async logout(refreshToken: string): Promise<void> {
    await this.prisma.session.deleteMany({ where: { refreshToken } });
  }

  async me(userId: number) {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: { id: true, correo: true, nombre: true, cedula: true, telefono: true, createdAt: true, updatedAt: true },
    });
    if (!user) throw new UnauthorizedException('No autenticado');
    const permissions = await this.rbac.getPermissionsByUserId(userId);
    return { ...user, telefono: user.telefono ?? '', permissions };
  }

  private async signAccessToken(userId: number): Promise<string> {
    return this.jwt.signAsync({ sub: userId });
  }

  private async issueRefreshToken(input: {
    userId: number;
    ipAddress?: string;
    userAgent?: string;
    expiresInDays: number;
  }): Promise<string> {
    const raw = await this.generateRefreshToken();
    const expiresAt = new Date(Date.now() + input.expiresInDays * 24 * 60 * 60 * 1000);

    await this.prisma.session.create({
      data: {
        userId: input.userId,
        refreshToken: raw,
        ipAddress: input.ipAddress ?? null,
        userAgent: input.userAgent ?? null,
        expiresAt,
      },
      select: { id: true },
    });

    return raw;
  }

  private async generateRefreshToken(): Promise<string> {
    // No usamos JWT aquí: token opaco para lookup directo en DB.
    const bytes = randomBytes(48);
    const base64 = bytes.toString('base64url');
    return `rt_${base64}`;
  }

  private async verifyPassword(stored: string, input: string, userId: number): Promise<boolean> {
    const looksBcrypt = stored?.startsWith('$2a$') || stored?.startsWith('$2b$') || stored?.startsWith('$2y$');
    if (looksBcrypt) {
      return bcrypt.compare(input, stored);
    }

    // Compatibilidad con passwords antiguos en texto plano: si coincide, migra a bcrypt.
    if (stored === input) {
      const hashed = await bcrypt.hash(input, 10);
      await this.prisma.user.update({
        where: { id: userId },
        data: {
          password: hashed,
          passwordChangeAt: new Date(),
        },
      });
      return true;
    }

    return false;
  }
}

