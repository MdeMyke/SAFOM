import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateTicketDto } from './dto/create-ticket.dto';
import { AssignTicketDto } from './dto/assign-ticket.dto';

@Injectable()
export class TicketeraService {
  constructor(private readonly prisma: PrismaService) {}

  async findTickets(params?: { archived?: boolean }) {
    const archived = params?.archived;
    const archivadoAtFilter =
      archived === true ? { not: null as any } : archived === false ? null : undefined;

    const tickets = await this.prisma.ticket.findMany({
      where: { deletedAt: null, archivadoAt: archivadoAtFilter },
      include: {
        estado: true,
        prioridad: true,
        categoria: true,
        subcategoria: true,
        asignaciones: {
          where: { esActual: true },
          include: { user: true },
        },
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
      asignadoA: t.asignaciones?.[0]?.user?.nombre ?? 'Sin asignar',
      categoriaId: t.categoriaId,
      categoriaNombre: t.categoria?.nombre ?? '',
      subcategoriaNombre: t.subcategoria?.nombre ?? '',
      updatedAt: t.updatedAt,
    }));
  }

  async archiveTicket(ticketId: number) {
    const existing = await this.prisma.ticket.findFirst({
      where: { id: ticketId, deletedAt: null },
      // `archivadoBy` puede no existir en los tipos si Prisma Client no está regenerado aún.
      // Lo leemos vía `any` más abajo cuando construimos el historial.
      select: { id: true, archivadoAt: true } as any,
    });
    if (!existing) {
      throw new NotFoundException('Ticket no encontrado');
    }
    if (existing.archivadoAt) {
      throw new BadRequestException('El ticket ya está archivado');
    }

    const archivedBy = await this.resolveDefaultUserId();
    const archivedAt = new Date();

    const valorAnterior = {
      archivado_at: existing.archivadoAt ?? null,
      archivado_by: (existing as any).archivadoBy ?? null,
    } as any;
    const valorNuevo = {
      archivado_at: archivedAt.toISOString(),
      archivado_by: archivedBy,
    } as any;

    const updated = await this.prisma.$transaction(async (tx) => {
      // Nota: si Prisma Client no está regenerado aún, `archivadoBy` no existe en los tipos.
      // Esto mantiene la compatibilidad hasta que se ejecute `npm run prisma:generate`.
      const archived = (await (tx.ticket.update as any)({
        where: { id: ticketId },
        data: {
          archivadoAt: archivedAt,
          archivadoBy: archivedBy,
          updatedBy: archivedBy,
        },
        include: {
          estado: true,
          prioridad: true,
          categoria: true,
          subcategoria: true,
          asignaciones: {
            where: { esActual: true },
            include: { user: true },
          },
        },
      })) as any;

      await tx.historialTicket.create({
        data: {
          ticketId,
          accion: 'archivo',
          descripcion: 'Ticket archivado',
          // Nota: estos campos son Json? en schema.prisma, pero si Prisma Client
          // aún no se regeneró, los tipos TS pueden seguir viéndolos como string.
          valorAnterior: valorAnterior as any,
          valorNuevo: valorNuevo as any,
          createdBy: archivedBy,
        },
      });

      return archived;
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
      asignadoA: updated.asignaciones?.[0]?.user?.nombre ?? 'Sin asignar',
      categoriaId: updated.categoriaId,
      categoriaNombre: updated.categoria?.nombre ?? '',
      subcategoriaNombre: updated.subcategoria?.nombre ?? '',
      updatedAt: updated.updatedAt,
    };
  }

  async unarchiveTicket(ticketId: number) {
    const existing = await this.prisma.ticket.findFirst({
      where: { id: ticketId, deletedAt: null },
      select: { id: true, archivadoAt: true } as any,
    });
    if (!existing) {
      throw new NotFoundException('Ticket no encontrado');
    }
    if (!existing.archivadoAt) {
      throw new BadRequestException('El ticket no está archivado');
    }

    const unarchivedBy = await this.resolveDefaultUserId();
    const valorAnterior = {
      archivado_at: existing.archivadoAt ? new Date(existing.archivadoAt as any).toISOString() : null,
      archivado_by: (existing as any).archivadoBy ?? null,
    } as any;
    const valorNuevo = {
      archivado_at: null,
      archivado_by: null,
    } as any;

    const updated = await this.prisma.$transaction(async (tx) => {
      const unarchived = (await (tx.ticket.update as any)({
        where: { id: ticketId },
        data: {
          archivadoAt: null,
          archivadoBy: null,
          updatedBy: unarchivedBy,
        },
        include: {
          estado: true,
          prioridad: true,
          categoria: true,
          subcategoria: true,
          asignaciones: {
            where: { esActual: true },
            include: { user: true },
          },
        },
      })) as any;

      await tx.historialTicket.create({
        data: {
          ticketId,
          accion: 'desarchivo',
          descripcion: 'Ticket desarchivado',
          valorAnterior: valorAnterior as any,
          valorNuevo: valorNuevo as any,
          createdBy: unarchivedBy,
        },
      });

      return unarchived;
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
      asignadoA: updated.asignaciones?.[0]?.user?.nombre ?? 'Sin asignar',
      categoriaId: updated.categoriaId,
      categoriaNombre: updated.categoria?.nombre ?? '',
      subcategoriaNombre: updated.subcategoria?.nombre ?? '',
      updatedAt: updated.updatedAt,
    };
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
          categoria: true,
          subcategoria: true,
          asignaciones: {
            where: { esActual: true },
            include: { user: true },
          },
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
        asignadoA: ticket.asignaciones?.[0]?.user?.nombre ?? 'Sin asignar',
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
        categoria: true,
        subcategoria: true,
        asignaciones: {
          where: { esActual: true },
          include: { user: true },
        },
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
          updatedBy: assignedBy,
        },
        include: {
          estado: true,
          prioridad: true,
          categoria: true,
          subcategoria: true,
          asignaciones: {
            where: { esActual: true },
            include: { user: true },
          },
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
      asignadoA: updated.asignaciones?.[0]?.user?.nombre ?? 'Sin asignar',
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

