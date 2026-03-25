import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateTicketDto } from './dto/create-ticket.dto';

@Injectable()
export class TicketeraService {
  constructor(private readonly prisma: PrismaService) {}

  async findTickets() {
    const tickets = await this.prisma.ticket.findMany({
      where: { deletedAt: null },
      include: {
        estado: true,
        prioridad: true,
        assignedTo: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    return tickets.map((t) => ({
      id: t.id,
      codigo: t.codigo,
      titulo: t.titulo,
      estado: t.estado?.nombre ?? '',
      prioridad: t.prioridad?.nombre ?? '',
      asignadoA: t.assignedTo ? t.assignedTo.nombre : 'Sin asignar',
      updatedAt: t.updatedAt,
    }));
  }

  async createTicket(dto: CreateTicketDto) {
    const titulo = dto.titulo?.trim();
    if (!titulo || titulo.length < 3) {
      throw new BadRequestException('El título es requerido');
    }

    const estadoAbierto = await this.prisma.estado.findFirst({
      where: { deletedAt: null, nombre: 'abierto' },
      select: { id: true },
    });
    let estadoId = estadoAbierto?.id;
    if (!estadoAbierto) {
      // Fallback para ambientes donde el seed usa nombres distintos (ej: "Abierto", "Pendiente").
      const estadoFallback = await this.prisma.estado.findFirst({
        where: { deletedAt: null },
        select: { id: true, nombre: true },
        orderBy: { id: 'asc' },
      });
      if (!estadoFallback) {
        throw new NotFoundException('No existe ningun estado activo en la base de datos');
      }
      estadoId = estadoFallback.id;
    }

    const userId = dto.userId ?? (await this.resolveDefaultUserId());
    const codigo = this.generateTicketCode();
    const ticket = await this.prisma.ticket.create({
      data: {
        codigo,
        titulo,
        descripcion: dto.descripcion?.trim() || null,
        userId,
        categoriaId: dto.categoriaId,
        subcategoriaId: dto.subcategoriaId,
        prioridadId: dto.prioridadId,
        estadoId: estadoId!,
        assignedToId: null,
        createdBy: userId,
        updatedBy: userId,
      },
      include: {
        estado: true,
        prioridad: true,
        assignedTo: true,
      },
    });

    return {
      id: ticket.id,
      codigo: ticket.codigo,
      titulo: ticket.titulo,
      estado: ticket.estado?.nombre ?? '',
      prioridad: ticket.prioridad?.nombre ?? '',
      asignadoA: ticket.assignedTo ? ticket.assignedTo.nombre : 'Sin asignar',
      updatedAt: ticket.updatedAt,
    };
  }

  private generateTicketCode(): string {
    // Mantiene la info temporal del timestamp, pero en formato compacto.
    return `TCK-${Date.now().toString(36).toUpperCase()}`;
  }

  private async resolveDefaultUserId(): Promise<number> {
    const user = await this.prisma.user.findFirst({
      where: { deletedAt: null },
      select: { id: true },
      orderBy: { id: 'asc' },
    });

    if (!user) {
      throw new NotFoundException('No existe ningun usuario activo para crear tickets');
    }

    return user.id;
  }

  async findCategoriasConSubcategorias() {
    const categorias = await this.prisma.categoria.findMany({
      where: { deletedAt: null },
      include: {
        subcategorias: {
          where: { deletedAt: null },
          orderBy: { nombre: 'asc' },
        },
      },
      orderBy: { nombre: 'asc' },
    });

    return categorias.map((c) => ({
      id: c.id,
      nombre: c.nombre,
      subcategorias: c.subcategorias.map((s) => ({
        id: s.id,
        nombre: s.nombre,
        categoriaId: s.categoriaId,
      })),
    }));
  }

  async findPrioridades() {
    const prioridades = await this.prisma.prioridad.findMany({
      where: { deletedAt: null },
      orderBy: [{ nivel: 'asc' }, { nombre: 'asc' }],
    });

    return prioridades.map((p) => ({
      id: p.id,
      nombre: p.nombre,
      nivel: p.nivel,
    }));
  }
}

