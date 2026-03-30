import { Controller, Get, UseGuards } from '@nestjs/common';
import { AppService } from './app.service';
import { JwtAuthGuard } from './modules/auth/guards/jwt-auth.guard';
import { Permisos } from './modules/rbac/decorators/permisos.decorator';
import { PermisosGuard } from './modules/rbac/guards/permisos.guard';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  @Get('admin/users')
  @UseGuards(JwtAuthGuard, PermisosGuard)
  @Permisos('users.read')
  getUsersAdminView(): string {
    return this.appService.getUsersAdminView();
  }
}
