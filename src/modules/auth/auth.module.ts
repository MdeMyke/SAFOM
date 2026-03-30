import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import type { StringValue } from 'ms';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { JwtStrategy } from './strategies/jwt.strategy';
import { RbacModule } from '../rbac/rbac.module';

const jwtAccessExpiresIn =
  (process.env.JWT_ACCESS_EXPIRES_IN as StringValue | undefined) ??
  ('15m' as StringValue);

@Module({
  imports: [
    PassportModule,
    RbacModule,
    JwtModule.register({
      secret: process.env.JWT_ACCESS_SECRET ?? process.env.JWT_SECRET ?? 'dev-secret-change-me',
      signOptions: { expiresIn: jwtAccessExpiresIn },
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtAuthGuard, JwtStrategy],
  exports: [AuthService, JwtAuthGuard],
})
export class AuthModule {}

