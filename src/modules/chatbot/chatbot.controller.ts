import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { RequestUser } from '../rbac/types/rbac.types';
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
  reply(@Req() req: Request, @Body() body: { toWaId?: string; text?: string }) {
    const user = req.user as RequestUser | undefined;
    if (!user?.id) {
      throw new UnauthorizedException('No autenticado');
    }
    return this.chatbotService.reply(body, user.id);
  }

  @Post('chatbot/conversations/:waId/status')
  @UseGuards(JwtAuthGuard)
  updateConversationStatus(
    @Req() req: Request,
    @Param('waId') waId: string,
    @Body() body: { status?: string; motivo?: string },
  ) {
    const user = req.user as RequestUser | undefined;
    if (!user?.id) {
      throw new UnauthorizedException('No autenticado');
    }
    return this.chatbotService.updateConversationStatus({
      waId,
      status: body?.status,
      motivo: body?.motivo,
      actorUserId: user.id,
    });
  }

  @Post('chatbot/conversations/:waId/fijar')
  @UseGuards(JwtAuthGuard)
  setConversationFijada(@Req() req: Request, @Param('waId') waId: string, @Body() body: { fijado?: boolean }) {
    const user = req.user as RequestUser | undefined;
    if (!user?.id) {
      throw new UnauthorizedException('No autenticado');
    }
    return this.chatbotService.setConversationFijada({
      waId,
      fijado: body?.fijado ?? true,
      actorUserId: user.id,
    });
  }

  @Get('chatbot/categorias-respuestas')
  @UseGuards(JwtAuthGuard)
  listCategoriasRespuestas() {
    return this.chatbotService.listCategoriasRespuestas();
  }

  @Post('chatbot/categorias-respuestas')
  @UseGuards(JwtAuthGuard)
  createCategoriaRespuesta(@Req() req: Request, @Body() body: { nombre?: string; descripcion?: string; color?: string }) {
    const user = req.user as RequestUser | undefined;
    if (!user?.id) {
      throw new UnauthorizedException('No autenticado');
    }
    return this.chatbotService.createCategoriaRespuesta(user.id, body);
  }

  @Post('chatbot/categorias-respuestas/:id/editar')
  @UseGuards(JwtAuthGuard)
  updateCategoriaRespuesta(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: { nombre?: string; descripcion?: string; color?: string },
  ) {
    const user = req.user as RequestUser | undefined;
    if (!user?.id) {
      throw new UnauthorizedException('No autenticado');
    }
    return (this.chatbotService as any).updateCategoriaRespuesta(user.id, Number(id), body);
  }

  @Post('chatbot/categorias-respuestas/:id/eliminar')
  @UseGuards(JwtAuthGuard)
  deleteCategoriaRespuesta(@Req() req: Request, @Param('id') id: string, @Body() body: { delete_with_respuestas?: boolean }) {
    const user = req.user as RequestUser | undefined;
    if (!user?.id) {
      throw new UnauthorizedException('No autenticado');
    }
    return (this.chatbotService as any).deleteCategoriaRespuesta(user.id, Number(id), {
      deleteWithRespuestas: body?.delete_with_respuestas ?? false,
    });
  }

  @Get('chatbot/respuestas-rapidas')
  @UseGuards(JwtAuthGuard)
  listRespuestasRapidas() {
    return this.chatbotService.listRespuestasRapidas();
  }

  @Post('chatbot/respuestas-rapidas')
  @UseGuards(JwtAuthGuard)
  createRespuestaRapida(
    @Req() req: Request,
    @Body() body: { titulo?: string; contenido?: string; es_publica?: boolean; categoria_id?: number | null },
  ) {
    const user = req.user as RequestUser | undefined;
    if (!user?.id) {
      throw new UnauthorizedException('No autenticado');
    }
    return this.chatbotService.createRespuestaRapida(user.id, body);
  }

  @Post('chatbot/respuestas-rapidas/reordenar')
  @UseGuards(JwtAuthGuard)
  reorderRespuestasRapidas(@Req() req: Request, @Body() body: { ids?: number[] }) {
    const user = req.user as RequestUser | undefined;
    if (!user?.id) {
      throw new UnauthorizedException('No autenticado');
    }
    return (this.chatbotService as any).reorderRespuestasRapidas(user.id, body?.ids ?? []);
  }

  @Post('chatbot/respuestas-rapidas/:id/fijar')
  @UseGuards(JwtAuthGuard)
  setRespuestaRapidaFijada(@Req() req: Request, @Param('id') id: string, @Body() body: { fijado?: boolean }) {
    const user = req.user as RequestUser | undefined;
    if (!user?.id) {
      throw new UnauthorizedException('No autenticado');
    }
    return this.chatbotService.setRespuestaRapidaFijada(user.id, Number(id), body?.fijado ?? true);
  }

  @Post('chatbot/respuestas-rapidas/:id/editar')
  @UseGuards(JwtAuthGuard)
  updateRespuestaRapida(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: { titulo?: string; contenido?: string; categoria_id?: number | null },
  ) {
    const user = req.user as RequestUser | undefined;
    if (!user?.id) {
      throw new UnauthorizedException('No autenticado');
    }
    return this.chatbotService.updateRespuestaRapida(user.id, Number(id), body);
  }

  @Post('chatbot/respuestas-rapidas/:id/eliminar')
  @UseGuards(JwtAuthGuard)
  deleteRespuestaRapida(@Req() req: Request, @Param('id') id: string) {
    const user = req.user as RequestUser | undefined;
    if (!user?.id) {
      throw new UnauthorizedException('No autenticado');
    }
    return this.chatbotService.deleteRespuestaRapida(user.id, Number(id));
  }
}

