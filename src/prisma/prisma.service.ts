import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  async onModuleInit() {
    // Para no romper tests/local si no configuraste `DATABASE_URL`.
    if (!process.env.DATABASE_URL) {
      this.logger.warn('DATABASE_URL no está definido; Prisma no se conectará automáticamente.');
      return;
    }

    await this.$connect();
    this.logger.log('Conectado a la base de datos con Prisma.');
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}

