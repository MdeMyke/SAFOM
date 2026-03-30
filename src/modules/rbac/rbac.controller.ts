import { Controller, Get, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RbacService } from './rbac.service';

@Controller('roles')
@UseGuards(JwtAuthGuard)
export class RbacController {
  constructor(private readonly rbacService: RbacService) {}

  @Get()
  findRoles() {
    return this.rbacService.findRoles();
  }
}

