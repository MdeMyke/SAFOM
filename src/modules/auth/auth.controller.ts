import { Body, Controller, Get, HttpCode, Post, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';

type LoginDto = {
  email: string;
  password: string;
  rememberMe?: boolean;
};

type RefreshDto = {
  refreshToken: string;
};

type LogoutDto = {
  refreshToken: string;
};

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('login')
  @HttpCode(200)
  async login(@Body() dto: LoginDto, @Req() req: Request) {
    const ipAddress = (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ?? req.ip;
    const userAgent = req.headers['user-agent'] ?? undefined;
    return this.authService.login({
      email: dto.email,
      password: dto.password,
      rememberMe: Boolean(dto.rememberMe),
      ipAddress,
      userAgent: typeof userAgent === 'string' ? userAgent : undefined,
    });
  }

  @Post('refresh')
  @HttpCode(200)
  async refresh(@Body() dto: RefreshDto, @Req() req: Request) {
    const ipAddress = (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ?? req.ip;
    const userAgent = req.headers['user-agent'] ?? undefined;
    return this.authService.refresh({
      refreshToken: dto.refreshToken,
      ipAddress,
      userAgent: typeof userAgent === 'string' ? userAgent : undefined,
    });
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@Body() dto: LogoutDto) {
    if (!dto.refreshToken) throw new UnauthorizedException('refreshToken requerido');
    await this.authService.logout(dto.refreshToken);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  async me(@Req() req: Request & { user?: { id: number } }) {
    if (!req.user?.id) throw new UnauthorizedException('No autenticado');
    return this.authService.me(req.user.id);
  }
}

