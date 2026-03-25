import { Body, Controller, Get, Post } from '@nestjs/common';
import { CreateTicketDto } from './dto/create-ticket.dto';
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

  @Get('categorias')
  findCategorias() {
    return this.ticketeraService.findCategoriasConSubcategorias();
  }

  @Get('prioridades')
  findPrioridades() {
    return this.ticketeraService.findPrioridades();
  }
}

