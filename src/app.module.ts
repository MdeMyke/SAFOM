import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './modules/auth/auth.module';
import { RbacModule } from './modules/rbac/rbac.module';
import { UsersModule } from './modules/users/users.module';
import { TicketeraModule } from './modules/ticketera/ticketera.module';
import { PrismaModule } from './prisma/prisma.module';

@Module({
  imports: [PrismaModule, AuthModule, RbacModule, UsersModule, TicketeraModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
