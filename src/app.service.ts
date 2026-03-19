import { Injectable } from '@nestjs/common';

@Injectable()
export class AppService {
  getHello(): string {
    return 'Hello World!';
  }

  getUsersAdminView(): string {
    return 'RBAC ok: tienes permiso users.read';
  }
}
