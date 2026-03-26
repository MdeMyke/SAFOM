import { Body, Controller, Get, Param, ParseIntPipe, Post } from '@nestjs/common';
import { CreateTicketDto } from './dto/create-ticket.dto';
import { AssignTicketDto } from './dto/assign-ticket.dto';
import { TicketeraService } from './ticketera.service';

@Controller()
export class TicketeraController {
  constructor(private readonly ticketeraService: TicketeraService) {}

  @Get('tickets')
  findTickets() {
    return this.ticketeraService.findTickets();
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

  @Get('categorias')
  findCategorias() {
    return this.ticketeraService.findCategoriasConSubcategorias();
  }

  @Get('prioridades')
  findPrioridades() {
    return this.ticketeraService.findPrioridades();
  }
}

