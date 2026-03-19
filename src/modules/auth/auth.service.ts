import { Injectable } from '@nestjs/common';

@Injectable()
export class AuthService {
  // Placeholder inicial: luego puede validar JWT/session y poblar req.user.
  validateToken(token: string | undefined): boolean {
    return Boolean(token);
  }
}

