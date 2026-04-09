import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { Request } from 'express';
import { ChatbotService } from './chatbot.service';

@Controller()
export class ChatbotController {
  constructor(private readonly chatbotService: ChatbotService) {}

  // =========================
  // WEBHOOK WhatsApp (público)
  // =========================

  @Get('webhook')
  verifyWebhook(@Req() req: Request) {
    return this.chatbotService.verifyWebhook(req.query);
  }

  @Post('webhook')
  @HttpCode(200)
  async receiveWebhook(@Body() body: unknown) {
    await this.chatbotService.receiveWebhook(body);
    return { ok: true };
  }

  // =========================
  // API interna (protegida)
  // =========================

  @Get('chatbot/conversations')
  @UseGuards(JwtAuthGuard)
  getConversations(@Query('limit') limit?: string) {
    return this.chatbotService.getConversations({ limit: Number(limit ?? 50) });
  }

  @Get('chatbot/conversations/:waId/messages')
  @UseGuards(JwtAuthGuard)
  getMessages(@Param('waId') waId: string, @Query('limit') limit?: string) {
    return this.chatbotService.getMessages({ waId, limit: Number(limit ?? 50) });
  }

  @Post('chatbot/reply')
  @UseGuards(JwtAuthGuard)
  reply(@Body() body: { toWaId?: string; text?: string }) {
    return this.chatbotService.reply(body);
  }
}

