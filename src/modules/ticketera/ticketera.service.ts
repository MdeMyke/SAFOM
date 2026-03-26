import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateTicketDto } from './dto/create-ticket.dto';
import { AssignTicketDto } from './dto/assign-ticket.dto';

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
        categoria: true,
        subcategoria: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    return tickets.map((t) => ({
      id: t.id,
      userId: t.solicitanteUserId,
      codigo: t.codigo,
      titulo: t.titulo,
      descripcion: t.descripcion ?? '',
      estado: t.estado?.nombre ?? '',
      prioridad: t.prioridad?.nombre ?? '',
      prioridadNivel: t.prioridad?.nivel ?? null,
      asignadoA: t.assignedTo ? t.assignedTo.nombre : 'Sin asignar',
      categoriaId: t.categoriaId,
      categoriaNombre: t.categoria?.nombre ?? '',
      subcategoriaNombre: t.subcategoria?.nombre ?? '',
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

    const ticket = await this.prisma.$transaction(async (tx) => {
      const created = await tx.ticket.create({
        data: {
          codigo,
          titulo,
          descripcion: dto.descripcion?.trim() || null,
          solicitanteUserId: userId,
          categoriaId: dto.categoriaId,
          subcategoriaId: dto.subcategoriaId,
          prioridadId: dto.prioridadId,
          estadoId: estadoId!,
          // El ticket se crea sin usuario asignado por defecto.
          assignedToId: null,
          createdBy: userId,
          updatedBy: userId,
        },
        select: { id: true },
      });

      return tx.ticket.findUniqueOrThrow({
        where: { id: created.id },
        include: {
          estado: true,
          prioridad: true,
          assignedTo: true,
          categoria: true,
          subcategoria: true,
        },
      });
      });

      return {
        id: ticket.id,
        userId: ticket.solicitanteUserId,
        codigo: ticket.codigo,
        titulo: ticket.titulo,
      descripcion: ticket.descripcion ?? '',
        estado: ticket.estado?.nombre ?? '',
        prioridad: ticket.prioridad?.nombre ?? '',
      prioridadNivel: ticket.prioridad?.nivel ?? null,
        asignadoA: ticket.assignedTo ? ticket.assignedTo.nombre : 'Sin asignar',
      categoriaId: ticket.categoriaId,
      categoriaNombre: ticket.categoria?.nombre ?? '',
      subcategoriaNombre: ticket.subcategoria?.nombre ?? '',
        updatedAt: ticket.updatedAt,
      };
  }

  async assignTicket(ticketId: number, dto: AssignTicketDto) {
    const ticket = await this.prisma.ticket.findFirst({
      where: { id: ticketId, deletedAt: null },
      include: {
        estado: true,
        prioridad: true,
        assignedTo: true,
        categoria: true,
        subcategoria: true,
      },
    });

    if (!ticket) {
      throw new NotFoundException('Ticket no encontrado');
    }

    const targetUser = await this.prisma.user.findFirst({
      where: { id: dto.userId, deletedAt: null },
      select: { id: true },
    });

    if (!targetUser) {
      throw new NotFoundException('Usuario no encontrado');
    }

    const assignedBy = await this.resolveDefaultUserId();

    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.ticketAsignacion.updateMany({
        where: { ticketId, esActual: true },
        data: { esActual: false },
      });

      await tx.ticketAsignacion.create({
        data: {
          ticketId,
          userId: targetUser.id,
          asignadoPor: assignedBy,
          esActual: true,
          asignadoEn: new Date(),
        },
      });

      const updatedTicket = await tx.ticket.update({
        where: { id: ticketId },
        data: {
          assignedToId: targetUser.id,
          updatedBy: assignedBy,
        },
        include: {
          estado: true,
          prioridad: true,
          assignedTo: true,
          categoria: true,
          subcategoria: true,
        },
      });

      return updatedTicket;
    });

    return {
      id: updated.id,
      userId: updated.solicitanteUserId,
      codigo: updated.codigo,
      titulo: updated.titulo,
      descripcion: updated.descripcion ?? '',
      estado: updated.estado?.nombre ?? '',
      prioridad: updated.prioridad?.nombre ?? '',
      prioridadNivel: updated.prioridad?.nivel ?? null,
      asignadoA: updated.assignedTo ? updated.assignedTo.nombre : 'Sin asignar',
      categoriaId: updated.categoriaId,
      categoriaNombre: updated.categoria?.nombre ?? '',
      subcategoriaNombre: updated.subcategoria?.nombre ?? '',
      updatedAt: updated.updatedAt,
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

