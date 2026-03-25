import { Controller, Get } from '@nestjs/common';
import { RbacService } from './rbac.service';

@Controller('roles')
export class RbacController {
  constructor(private readonly rbacService: RbacService) {}

  @Get()
  findRoles() {
    return this.rbacService.findRoles();
  }
}

