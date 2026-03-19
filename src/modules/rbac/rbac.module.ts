import { Module } from '@nestjs/common';
import { RbacService } from './rbac.service';
import { PermisosGuard } from './guards/permisos.guard';

@Module({
  providers: [RbacService, PermisosGuard],
  exports: [RbacService, PermisosGuard],
})
export class RbacModule {}

