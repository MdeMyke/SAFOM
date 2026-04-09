import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { ChatbotController } from './chatbot.controller';
import { ChatbotService } from './chatbot.service';

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [ChatbotController],
  providers: [ChatbotService],
})
export class ChatbotModule {}

