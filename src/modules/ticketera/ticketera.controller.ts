import { Body, Controller, Get, Param, ParseIntPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CreateTicketDto } from './dto/create-ticket.dto';
import { AssignTicketDto } from './dto/assign-ticket.dto';
import { RedirectTicketDto } from './dto/redirect-ticket.dto';
import { TicketeraService } from './ticketera.service';

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
}

