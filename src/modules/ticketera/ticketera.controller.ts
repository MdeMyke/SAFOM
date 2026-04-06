import { Body, Controller, Get, Param, ParseIntPipe, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CreateTicketDto } from './dto/create-ticket.dto';
import { AssignTicketDto } from './dto/assign-ticket.dto';
import { RedirectTicketDto } from './dto/redirect-ticket.dto';
import { CreateComentarioDto } from './dto/create-comentario.dto';
import { CreateResolucionCierreDto } from './dto/create-resolucion-cierre.dto';
import { ReabrirTicketDto } from './dto/reabrir-ticket.dto';
import { TicketeraService } from './ticketera.service';
import type { Request } from 'express';

@Controller()
@UseGuards(JwtAuthGuard)
export class TicketeraController {
  constructor(private readonly ticketeraService: TicketeraService) {}

  @Get('tickets')
  findTickets(@Query('archived') archived?: string) {
    const isArchived = archived === 'true' ? true : archived === 'false' ? false : undefined;
    return this.ticketeraService.findTickets({ archived: isArchived });
  }

  @Post('tickets')
  createTicket(@Body() dto: CreateTicketDto) {
    return this.ticketeraService.createTicket(dto);
  }

  @Post('tickets/:ticketId/assign')
  assignTicket(
    @Param('ticketId', ParseIntPipe) ticketId: number,
    @Body() dto: AssignTicketDto,
  ) {
    return this.ticketeraService.assignTicket(ticketId, dto);
  }

  @Patch('tickets/:ticketId/archive')
  archiveTicket(@Param('ticketId', ParseIntPipe) ticketId: number) {
    return this.ticketeraService.archiveTicket(ticketId);
  }

  @Patch('tickets/:ticketId/unarchive')
  unarchiveTicket(@Param('ticketId', ParseIntPipe) ticketId: number) {
    return this.ticketeraService.unarchiveTicket(ticketId);
  }

  @Patch('tickets/:ticketId/redirect')
  redirectTicket(
    @Param('ticketId', ParseIntPipe) ticketId: number,
    @Body() dto: RedirectTicketDto,
  ) {
    return this.ticketeraService.redirectTicket(ticketId, dto);
  }

  @Get('categorias')
  findCategorias() {
    return this.ticketeraService.findCategoriasConSubcategorias();
  }

  @Get('prioridades')
  findPrioridades() {
    return this.ticketeraService.findPrioridades();
  }

  @Get('tickets/:ticketId/comentarios')
  getComentarios(
    @Param('ticketId', ParseIntPipe) ticketId: number,
    @Req() req: Request & { user?: { id?: number } },
  ) {
    const actorId = req.user?.id;
    return this.ticketeraService.getComentarios(ticketId, actorId);
  }

  @Post('tickets/:ticketId/comentarios')
  createComentario(
    @Param('ticketId', ParseIntPipe) ticketId: number,
    @Body() dto: CreateComentarioDto,
    @Req() req: Request & { user?: { id?: number } },
  ) {
    const actorId = req.user?.id;
    return this.ticketeraService.createComentario(ticketId, dto.texto, actorId);
  }

  @Get('tickets/:ticketId/timeline')
  getTimeline(@Param('ticketId', ParseIntPipe) ticketId: number) {
    return this.ticketeraService.getTimeline(ticketId);
  }

  @Get('tickets/:ticketId/historial-resoluciones')
  getHistorialResoluciones(@Param('ticketId', ParseIntPipe) ticketId: number) {
    return this.ticketeraService.getHistorialResoluciones(ticketId);
  }

  @Post('tickets/:ticketId/resolucion-cierre')
  createResolucionCierre(
    @Param('ticketId', ParseIntPipe) ticketId: number,
    @Body() dto: CreateResolucionCierreDto,
    @Req() req: Request & { user?: { id?: number } },
  ) {
    const actorId = req.user?.id;
    return this.ticketeraService.createResolucionCierre(ticketId, dto, actorId);
  }

  @Post('tickets/:ticketId/reabrir')
  reabrirTicket(
    @Param('ticketId', ParseIntPipe) ticketId: number,
    @Body() dto: ReabrirTicketDto,
    @Req() req: Request & { user?: { id?: number } },
  ) {
    const actorId = req.user?.id;
    return this.ticketeraService.reabrirTicket(ticketId, dto, actorId);
  }
}

