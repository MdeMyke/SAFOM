import { SetMetadata } from '@nestjs/common';
import { PERMISOS_KEY } from '../constants/rbac.constants';

export const Permisos = (...permisos: string[]) =>
  SetMetadata(PERMISOS_KEY, permisos);

