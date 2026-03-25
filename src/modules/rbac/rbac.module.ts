import { Module } from '@nestjs/common';
import { RbacController } from './rbac.controller';
import { RbacService } from './rbac.service';
import { PermisosGuard } from './guards/permisos.guard';

@Module({
  controllers: [RbacController],
  providers: [RbacService, PermisosGuard],
  exports: [RbacService, PermisosGuard],
})
export class RbacModule {}

