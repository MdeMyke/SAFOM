import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateTicketDto } from './dto/create-ticket.dto';
import { AssignTicketDto } from './dto/assign-ticket.dto';
import { RedirectTicketDto } from './dto/redirect-ticket.dto';
import { CreateResolucionCierreDto } from './dto/create-resolucion-cierre.dto';
import { ReabrirTicketDto } from './dto/reabrir-ticket.dto';

@Injectable()
export class TicketeraService {
  constructor(private readonly prisma: PrismaService) {}

  async getHistorialResoluciones(ticketId: number) {
    const ticket = await this.prisma.ticket.findFirst({
      where: { id: ticketId, deletedAt: null },
      select: { id: true },
    });
    if (!ticket) throw new NotFoundException('Ticket no encontrado');

    const historial = await this.prisma.historialTicket.findMany({
      where: {
        ticketId,
        deletedAt: null,
        accion: { in: ['resolucion', 'cierre', 'reabierto'] },
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        accion: true,
        descripcion: true,
        createdAt: true,
        creador: { select: { nombre: true } },
      },
    });

    return historial.map((h) => ({
      id: h.id,
      tipo: (h.accion as 'resolucion' | 'cierre' | 'reabierto') ?? 'resolucion',
      mensaje: h.descripcion ?? '',
      createdAt: h.createdAt.toISOString(),
      autorNombre: h.creador?.nombre ?? 'Usuario',
    }));
  }

  async createResolucionCierre(ticketId: number, dto: CreateResolucionCierreDto, actorId?: number) {
    if (!actorId) throw new BadRequestException('No autenticado');

    const tipo = dto.tipo;
    if (tipo !== 'resolucion' && tipo !== 'cierre') {
      throw new BadRequestException('Tipo inválido');
    }

    const mensaje = (dto.mensaje ?? '').trim();
    if (!mensaje || mensaje.length < 3) {
      throw new BadRequestException('El mensaje es requerido');
    }

    const ticket = await this.prisma.ticket.findFirst({
      where: { id: ticketId, deletedAt: null },
      select: { id: true, estadoId: true },
    });
    if (!ticket) throw new NotFoundException('Ticket no encontrado');

    const targetEstadoNombre = tipo === 'cierre' ? 'cerrado' : 'pendiente_aprobacion';
    const targetEstado = await this.prisma.estado.findFirst({
      where: { deletedAt: null, nombre: targetEstadoNombre },
      select: { id: true, nombre: true },
    });
    if (!targetEstado) {
      throw new NotFoundException(`No existe el estado '${targetEstadoNombre}'`);
    }

    const valorAnterior = { estado_id: ticket.estadoId } as any;
    const valorNuevo = { estado_id: targetEstado.id, tipo } as any;

    const created = await this.prisma.$transaction(async (tx) => {
      await tx.ticket.update({
        where: { id: ticketId },
        data: { estadoId: targetEstado.id, updatedBy: actorId },
        select: { id: true },
      });

      return tx.historialTicket.create({
        data: {
          ticketId,
          accion: tipo,
          descripcion: mensaje,
          valorAnterior: valorAnterior as any,
          valorNuevo: valorNuevo as any,
          createdBy: actorId,
        },
        select: {
          id: true,
          accion: true,
          descripcion: true,
          createdAt: true,
          creador: { select: { nombre: true } },
        },
      });
    });

    return {
      id: created.id,
      tipo: (created.accion as 'resolucion' | 'cierre') ?? tipo,
      mensaje: created.descripcion ?? '',
      createdAt: created.createdAt.toISOString(),
      autorNombre: created.creador?.nombre ?? 'Usuario',
    };
  }

  async reabrirTicket(ticketId: number, dto: ReabrirTicketDto, actorId?: number) {
    if (!actorId) throw new BadRequestException('No autenticado');

    const mensaje = (dto.mensaje ?? '').trim() || 'Ticket reabierto';

    const ticket = await this.prisma.ticket.findFirst({
      where: { id: ticketId, deletedAt: null },
      select: { id: true, estadoId: true },
    });
    if (!ticket) throw new NotFoundException('Ticket no encontrado');

    const estadoAbierto = await this.prisma.estado.findFirst({
      where: { deletedAt: null, nombre: 'abierto' },
      select: { id: true, nombre: true },
    });
    if (!estadoAbierto) {
      throw new NotFoundException(`No existe el estado 'abierto'`);
    }

    const valorAnterior = { estado_id: ticket.estadoId } as any;
    const valorNuevo = { estado_id: estadoAbierto.id } as any;

    const created = await this.prisma.$transaction(async (tx) => {
      await tx.ticket.update({
        where: { id: ticketId },
        data: { estadoId: estadoAbierto.id, updatedBy: actorId },
        select: { id: true },
      });

      return tx.historialTicket.create({
        data: {
          ticketId,
          accion: 'reabierto',
          descripcion: mensaje,
          valorAnterior: valorAnterior as any,
          valorNuevo: valorNuevo as any,
          createdBy: actorId,
        },
        select: {
          id: true,
          accion: true,
          descripcion: true,
          createdAt: true,
          creador: { select: { nombre: true } },
        },
      });
    });

    return {
      id: created.id,
      tipo: 'reabierto' as const,
      mensaje: created.descripcion ?? '',
      createdAt: created.createdAt.toISOString(),
      autorNombre: created.creador?.nombre ?? 'Usuario',
    };
  }

  async getTimeline(ticketId: number) {
    const ticket = await this.prisma.ticket.findFirst({
      where: { id: ticketId, deletedAt: null },
      select: {
        id: true,
        codigo: true,
        createdAt: true,
        user: { select: { nombre: true } },
      },
    });
    if (!ticket) {
      throw new NotFoundException('Ticket no encontrado');
    }

    const [asignaciones, historial] = await Promise.all([
      this.prisma.ticketAsignacion.findMany({
        where: { ticketId },
        orderBy: { asignadoEn: 'asc' },
        select: {
          id: true,
          asignadoEn: true,
          esActual: true,
          user: { select: { nombre: true } },
          por: { select: { nombre: true } },
        },
      }),
      this.prisma.historialTicket.findMany({
        where: { ticketId, deletedAt: null },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          accion: true,
          descripcion: true,
          createdAt: true,
          creador: { select: { nombre: true } },
        },
      }),
    ]);

    const events: Array<{
      id: string;
      tipo: 'creacion' | 'asignacion' | 'historial';
      fecha: string;
      titulo: string;
      detalle?: string | null;
    }> = [];

    // 1) Siempre empieza con la creación del ticket
    events.push({
      id: `creacion_${ticket.id}`,
      tipo: 'creacion',
      fecha: ticket.createdAt.toISOString(),
      titulo: `Ticket creado por ${ticket.user?.nombre ?? 'Usuario'}`,
      detalle: `Código ${ticket.codigo}`,
    });

    // 2) Puntos por asignaciones (tabla ticket_asignaciones)
    for (const a of asignaciones) {
      const asignadoA = a.user?.nombre ?? 'Usuario';
      const por = a.por?.nombre ?? 'Usuario';
      events.push({
        id: `asignacion_${a.id}`,
        tipo: 'asignacion',
        fecha: a.asignadoEn.toISOString(),
        titulo: `Asignado a ${asignadoA}`,
        detalle: `Por ${por}${a.esActual ? ' (actual)' : ''}`,
      });
    }

    // 3) Puntos por historial (tabla historial_tickets)
    for (const h of historial) {
      const creador = h.creador?.nombre ?? 'Usuario';
      events.push({
        id: `historial_${h.id}`,
        tipo: 'historial',
        fecha: h.createdAt.toISOString(),
        titulo: `${h.accion} · ${creador}`,
        detalle: h.descripcion ?? null,
      });
    }

    // Orden global por fecha
    events.sort((a, b) => new Date(a.fecha).getTime() - new Date(b.fecha).getTime());
    return events;
  }

  async getComentarios(ticketId: number, actorId?: number) {
    const comments = await this.prisma.comentario.findMany({
      where: { ticketId, deletedAt: null },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        comentario: true,
        createdAt: true,
        userId: true,
        user: {
          select: {
            nombre: true,
          },
        },
      },
    });

    return comments.map((c) => ({
      id: c.id,
      texto: (c.comentario ?? '').toString(),
      createdAt: c.createdAt.toISOString(),
      autor: actorId && c.userId === actorId ? 'yo' : 'otro',
      autorNombre: c.user?.nombre ?? 'Usuario',
    }));
  }

  async createComentario(ticketId: number, texto: string | undefined | null, actorId?: number) {
    const trimmed = (texto ?? '').trim();
    if (!trimmed || trimmed.length < 1) {
      throw new BadRequestException('El texto del comentario es requerido');
    }
    if (!actorId) {
      throw new BadRequestException('No autenticado');
    }

    const ticket = await this.prisma.ticket.findFirst({
      where: { id: ticketId, deletedAt: null },
      select: { id: true },
    });

    if (!ticket) throw new NotFoundException('Ticket no encontrado');

    const comentario = await this.prisma.comentario.create({
      data: {
        ticketId,
        userId: actorId,
        comentario: trimmed,
        createdBy: actorId,
        updatedBy: actorId,
      },
      select: {
        id: true,
        comentario: true,
        createdAt: true,
        userId: true,
        user: {
          select: { nombre: true },
        },
      },
    });

    return {
      id: comentario.id,
      texto: (comentario.comentario ?? '').toString(),
      createdAt: comentario.createdAt.toISOString(),
      autor: 'yo',
      autorNombre: comentario.user?.nombre ?? 'Tú',
    };
  }

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
      subcategoriaId: t.subcategoriaId,
      categoriaNombre: t.categoria?.nombre ?? '',
      subcategoriaNombre: t.subcategoria?.nombre ?? '',
      updatedAt: t.updatedAt,
    }));
  }

  async redirectTicket(ticketId: number, dto: RedirectTicketDto) {
    const motivo = dto.motivo?.trim();
    if (!motivo || motivo.length < 3) {
      throw new BadRequestException('El motivo es requerido');
    }

    const existing = await this.prisma.ticket.findFirst({
      where: { id: ticketId, deletedAt: null },
      select: {
        id: true,
        categoriaId: true,
        subcategoriaId: true,
      },
    });
    if (!existing) throw new NotFoundException('Ticket no encontrado');

    const categoria = await this.prisma.categoria.findFirst({
      where: { id: dto.categoriaId, deletedAt: null },
      select: { id: true, nombre: true },
    });
    if (!categoria) throw new NotFoundException('Categoría no encontrada');

    const subcategoria = await this.prisma.subcategoria.findFirst({
      where: { id: dto.subcategoriaId, deletedAt: null },
      select: { id: true, nombre: true, categoriaId: true },
    });
    if (!subcategoria) throw new NotFoundException('Subcategoría no encontrada');
    if (subcategoria.categoriaId !== categoria.id) {
      throw new BadRequestException('La subcategoría no pertenece a la categoría seleccionada');
    }

    const actorId = await this.resolveDefaultUserId();

    const valorAnterior = {
      categoria_id: existing.categoriaId,
      subcategoria_id: existing.subcategoriaId,
    } as any;
    const valorNuevo = {
      categoria_id: categoria.id,
      subcategoria_id: subcategoria.id,
      motivo,
    } as any;

    const updated = await this.prisma.$transaction(async (tx) => {
      const ticket = await tx.ticket.update({
        where: { id: ticketId },
        data: {
          categoriaId: categoria.id,
          subcategoriaId: subcategoria.id,
          updatedBy: actorId,
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

      await tx.historialTicket.create({
        data: {
          ticketId,
          accion: 'redireccionamiento',
          descripcion: motivo,
          valorAnterior: valorAnterior as any,
          valorNuevo: valorNuevo as any,
          createdBy: actorId,
        },
      });

      return ticket;
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
      subcategoriaId: updated.subcategoriaId,
      categoriaNombre: updated.categoria?.nombre ?? '',
      subcategoriaNombre: updated.subcategoria?.nombre ?? '',
      updatedAt: updated.updatedAt,
    };
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
      subcategoriaId: updated.subcategoriaId,
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
      subcategoriaId: updated.subcategoriaId,
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
      subcategoriaId: ticket.subcategoriaId,
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
      subcategoriaId: updated.subcategoriaId,
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

