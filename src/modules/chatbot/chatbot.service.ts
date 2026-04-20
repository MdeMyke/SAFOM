import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

type VerifyWebhookQuery = Record<string, unknown>;

/** Catálogo `estados` (ej. id 1 = abierto). Sobrescribible con CONVERSACION_ESTADO_ABIERTO_ID. */
const ESTADO_CONVERSACION_ABIERTO_ID =
  Number(process.env.CONVERSACION_ESTADO_ABIERTO_ID) > 0
    ? Number(process.env.CONVERSACION_ESTADO_ABIERTO_ID)
    : 1;

/** Catálogo `estados` (ej. id 3 = en_progreso). Sobrescribible con CONVERSACION_ESTADO_EN_PROGRESO_ID. */
const ESTADO_CONVERSACION_EN_PROGRESO_ID =
  Number(process.env.CONVERSACION_ESTADO_EN_PROGRESO_ID) > 0
    ? Number(process.env.CONVERSACION_ESTADO_EN_PROGRESO_ID)
    : 3;

/** Catálogo `estados` (ej. id 6 = cerrado). Sobrescribible con CONVERSACION_ESTADO_CERRADO_ID. */
const ESTADO_CONVERSACION_CERRADO_ID =
  Number(process.env.CONVERSACION_ESTADO_CERRADO_ID) > 0
    ? Number(process.env.CONVERSACION_ESTADO_CERRADO_ID)
    : 6;

@Injectable()
export class ChatbotService {
  private readonly logger = new Logger(ChatbotService.name);
  private static warnedMissingWhatsAppEnv = false;

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Nota: mientras no se ejecute `prisma generate` después de cambiar `schema.prisma`,
   * TypeScript no ve los nuevos modelos en el cliente y marca errores.
   * Este accessor evita bloquear el build local/CI; al generar Prisma, puede
   * volver a tiparse si quieres.
   */
  private get db(): any {
    return this.prisma as any;
  }

  verifyWebhook(query: VerifyWebhookQuery) {
    const mode = String((query as any)?.['hub.mode'] ?? '');
    const token = String((query as any)?.['hub.verify_token'] ?? '');
    const challenge = (query as any)?.['hub.challenge'];

    const expected = (process.env.WHATSAPP_VERIFY_TOKEN ?? '').trim();
    if (!expected) {
      this.logger.warn('WHATSAPP_VERIFY_TOKEN no está definido; verificación de webhook fallará.');
    }

    if (mode && token) {
      if (token === expected) {
        return String(challenge ?? '');
      }
      throw new BadRequestException('Token de verificación inválido');
    }

    throw new BadRequestException('Faltan parámetros de verificación');
  }

  async receiveWebhook(payload: unknown): Promise<void> {
    await this.saveIncomingWhatsAppMessages(payload);
  }

  async getConversations({ limit }: { limit: number }) {
    const take = clampInt(limit, 1, 100, 50);

    const all = await this.db.conversacion.findMany({
      where: { deletedAt: null },
      orderBy: [{ id: 'desc' }],
      include: {
        estado: { select: { id: true, nombre: true } },
        mensajes: {
          take: 1,
          orderBy: { id: 'desc' },
          select: { tipo: true, contenido: true, createdAt: true },
        },
      },
    });

    const grouped = new Map<string, typeof all>();
    for (const c of all) {
      if (!grouped.has(c.waId)) grouped.set(c.waId, []);
      grouped.get(c.waId)!.push(c);
    }

    const conversations: typeof all = [];
    for (const rows of grouped.values()) {
      rows.sort((a: (typeof all)[number], b: (typeof all)[number]) => b.id - a.id);
      const open = rows.find((r: (typeof all)[number]) => !this.isConversationClosedRow(r));
      conversations.push(open ?? rows[0]);
    }

    conversations.sort((a, b) => {
      const pin = Number(Boolean(b.fijado)) - Number(Boolean(a.fijado));
      if (pin !== 0) return pin;
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    });

    return conversations.slice(0, take).map((c) => {
      const last = c.mensajes[0] ?? null;
      return {
        conversation_id: c.id,
        wa_id: c.waId,
        name: c.nombre,
        fijado: Boolean(c.fijado),
        status: c.estado?.nombre ?? null,
        estado_id: c.estadoId,
        last_type: last?.tipo ?? null,
        last_content: last?.contenido ?? null,
        last_created_at: last?.createdAt ?? null,
      };
    });
  }

  async getMessages({ waId, limit }: { waId: string; limit: number }) {
    const take = clampInt(limit, 1, 200, 50);

    const conversation = await this.findCurrentConversationForWaId(waId);
    if (!conversation) return [];

    const messages = await this.db.mensaje.findMany({
      where: { conversacionId: conversation.id },
      take,
      orderBy: { id: 'desc' },
      select: {
        id: true,
        idExterno: true,
        enviadoPorMi: true,
        tipo: true,
        contenido: true,
        createdAt: true,
        meta: true,
      },
    });

    return messages.map((m) => ({
      id: m.id,
      external_id: m.idExterno,
      from_me: m.enviadoPorMi ? 1 : 0,
      type: m.tipo,
      content: m.contenido,
      created_at: m.createdAt,
      meta: m.meta,
    }));
  }

  async reply(body: { toWaId?: string; text?: string }, actorUserId: number) {
    const toWaId = String(body?.toWaId ?? '').trim();
    const text = String(body?.text ?? '').trim();

    if (!toWaId || !text) {
      throw new BadRequestException('Se requiere { toWaId, text }');
    }
    if (!actorUserId || actorUserId < 1) {
      throw new BadRequestException('Usuario no válido');
    }

    const apiJson = await this.sendWhatsAppText({ toWaId, text });

    const externalId =
      (apiJson as any)?.messages?.[0]?.id ??
      `local-${Date.now()}-${Math.random().toString(16).slice(2)}`;

    await this.prisma.$transaction(async (tx) => {
      const conv = await this.getOrCreateActiveConversationTx(tx, toWaId, null);

      if (conv.estadoId === ESTADO_CONVERSACION_ABIERTO_ID) {
        await tx.historialEstadoConversacion.create({
          data: {
            conversacionId: conv.id,
            estadoAnteriorId: ESTADO_CONVERSACION_ABIERTO_ID,
            estadoNuevoId: ESTADO_CONVERSACION_EN_PROGRESO_ID,
            cambiadoPor: actorUserId,
            motivo: 'Primer mensaje del agente desde inbox',
          },
        });
        await tx.conversacion.update({
          where: { id: conv.id },
          data: { estadoId: ESTADO_CONVERSACION_EN_PROGRESO_ID },
        });
      }

      await tx.mensaje.create({
        data: {
          conversacionId: conv.id,
          idExterno: String(externalId),
          enviadoPorMi: true,
          tipo: 'text',
          contenido: text,
          meta: {
            outgoing: true,
            api: apiJson,
            source: 'inbox_agent',
            agentUserId: actorUserId,
          } as object,
        },
      });
    });

    return { ok: true, api: apiJson };
  }

  async updateConversationStatus(opts: { waId: string; status?: string; motivo?: string; actorUserId: number }) {
    const waId = String(opts.waId ?? '').trim();
    const actorUserId = Number(opts.actorUserId ?? 0);
    const normalizedStatus = normalizeStatusName(opts.status);
    const motivo = String(opts.motivo ?? '').trim() || 'Cambio de estado desde inbox';

    if (!waId) throw new BadRequestException('Se requiere waId');
    if (!actorUserId || actorUserId < 1) throw new BadRequestException('Usuario no válido');
    if (!normalizedStatus) throw new BadRequestException('Se requiere status');
    if (!['resuelto', 'cerrado'].includes(normalizedStatus)) {
      throw new BadRequestException('Estado no permitido');
    }

    const conversation = await this.findCurrentConversationForWaId(waId);
    if (!conversation) throw new BadRequestException('Conversación no encontrada');

    const targetState = await this.db.estado.findFirst({
      where: { nombre: normalizedStatus },
      select: { id: true, nombre: true },
    });
    if (!targetState) throw new BadRequestException('Estado destino no existe en catálogo');

    if (conversation.estadoId === targetState.id) {
      return {
        ok: true,
        conversation_id: conversation.id,
        wa_id: conversation.waId,
        estado_id: conversation.estadoId,
        status: conversation.estado?.nombre ?? targetState.nombre,
      };
    }

    await this.db.$transaction(async (tx: any) => {
      await tx.historialEstadoConversacion.create({
        data: {
          conversacionId: conversation.id,
          estadoAnteriorId: conversation.estadoId,
          estadoNuevoId: targetState.id,
          cambiadoPor: actorUserId,
          motivo,
        },
      });
      await tx.conversacion.update({
        where: { id: conversation.id },
        data: { estadoId: targetState.id },
      });
    });

    return {
      ok: true,
      conversation_id: conversation.id,
      wa_id: conversation.waId,
      estado_id: targetState.id,
      status: targetState.nombre,
    };
  }

  async setConversationFijada(opts: { waId: string; fijado?: boolean; actorUserId: number }) {
    const waId = String(opts.waId ?? '').trim();
    const actorUserId = Number(opts.actorUserId ?? 0);
    const fijado = Boolean(opts.fijado);

    if (!waId) throw new BadRequestException('Se requiere waId');
    if (!actorUserId || actorUserId < 1) throw new BadRequestException('Usuario no válido');

    const conversation = await this.findCurrentConversationForWaId(waId);
    if (!conversation) throw new BadRequestException('Conversación no encontrada');

    if (Boolean(conversation.fijado) === fijado) {
      return {
        ok: true,
        conversation_id: conversation.id,
        wa_id: conversation.waId,
        fijado: Boolean(conversation.fijado),
      };
    }

    const updated = await this.db.conversacion.update({
      where: { id: conversation.id },
      data: { fijado },
      select: { id: true, waId: true, fijado: true },
    });

    return {
      ok: true,
      conversation_id: updated.id,
      wa_id: updated.waId,
      fijado: Boolean(updated.fijado),
    };
  }

  async listCategoriasRespuestas() {
    return this.db.categoriaRespuesta.findMany({
      where: { deletedAt: null },
      orderBy: { nombre: 'asc' },
      select: { id: true, nombre: true, descripcion: true, color: true },
    });
  }

  async createCategoriaRespuesta(
    actorUserId: number,
    body: { nombre?: string; descripcion?: string | null; color?: string | null },
  ) {
    if (!actorUserId || actorUserId < 1) throw new BadRequestException('Usuario no válido');
    const nombre = String(body?.nombre ?? '').trim();
    if (!nombre) throw new BadRequestException('Se requiere nombre');

    return this.db.categoriaRespuesta.create({
      data: {
        nombre,
        descripcion: body.descripcion != null ? String(body.descripcion).trim() || null : null,
        color: body.color != null ? String(body.color).trim() || null : null,
        createdBy: actorUserId,
      },
      select: { id: true, nombre: true, descripcion: true, color: true },
    });
  }

  async updateCategoriaRespuesta(
    actorUserId: number,
    id: number,
    body: { nombre?: string; descripcion?: string | null; color?: string | null },
  ) {
    if (!actorUserId || actorUserId < 1) throw new BadRequestException('Usuario no válido');
    if (!Number.isFinite(id) || id < 1) throw new BadRequestException('Id inválido');

    const existing = await this.db.categoriaRespuesta.findFirst({
      where: { id, deletedAt: null },
      select: { id: true },
    });
    if (!existing) throw new BadRequestException('Categoría no encontrada');

    const nombre = String(body?.nombre ?? '').trim();
    if (!nombre) throw new BadRequestException('Se requiere nombre');

    return this.db.categoriaRespuesta.update({
      where: { id },
      data: {
        nombre,
        descripcion: body.descripcion != null ? String(body.descripcion).trim() || null : null,
        color: body.color != null ? String(body.color).trim() || null : null,
        updatedBy: actorUserId,
      },
      select: { id: true, nombre: true, descripcion: true, color: true },
    });
  }

  async deleteCategoriaRespuesta(actorUserId: number, id: number, opts?: { deleteWithRespuestas?: boolean }) {
    if (!actorUserId || actorUserId < 1) throw new BadRequestException('Usuario no válido');
    if (!Number.isFinite(id) || id < 1) throw new BadRequestException('Id inválido');
    const deleteWithRespuestas = Boolean(opts?.deleteWithRespuestas);

    const existing = await this.db.categoriaRespuesta.findFirst({
      where: { id, deletedAt: null },
      select: { id: true },
    });
    if (!existing) throw new BadRequestException('Categoría no encontrada');

    await this.db.$transaction(async (tx: any) => {
      if (deleteWithRespuestas) {
        await tx.respuestaRapida.updateMany({
          where: { categoriaId: id, deletedAt: null },
          data: {
            deletedAt: new Date(),
            deletedBy: actorUserId,
            updatedBy: actorUserId,
          },
        });
      } else {
        await tx.respuestaRapida.updateMany({
          where: { categoriaId: id, deletedAt: null },
          data: { categoriaId: null, updatedBy: actorUserId },
        });
      }
      await tx.categoriaRespuesta.update({
        where: { id },
        data: {
          deletedAt: new Date(),
          deletedBy: actorUserId,
          updatedBy: actorUserId,
        },
      });
    });

    return { ok: true };
  }

  async listRespuestasRapidas() {
    return this.db.respuestaRapida.findMany({
      where: { deletedAt: null },
      orderBy: [{ fijado: 'desc' }, { orden: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        titulo: true,
        contenido: true,
        esPublica: true,
        categoriaId: true,
        orden: true,
        fijado: true,
      },
    });
  }

  async createRespuestaRapida(
    actorUserId: number,
    body: {
      titulo?: string;
      contenido?: string;
      es_publica?: boolean;
      categoria_id?: number | null;
    },
  ) {
    if (!actorUserId || actorUserId < 1) throw new BadRequestException('Usuario no válido');
    const titulo = String(body?.titulo ?? '').trim();
    const contenido = String(body?.contenido ?? '').trim();
    if (!titulo) throw new BadRequestException('Se requiere titulo');
    if (!contenido) throw new BadRequestException('Se requiere contenido');

    const esPublica = Boolean(body?.es_publica);
    let categoriaId: number | null = null;
    if (body?.categoria_id != null) {
      const cid = Number(body.categoria_id);
      if (!Number.isFinite(cid) || cid < 1) throw new BadRequestException('categoria_id inválido');
      const cat = await this.db.categoriaRespuesta.findFirst({
        where: { id: cid, deletedAt: null },
        select: { id: true },
      });
      if (!cat) throw new BadRequestException('Categoría no encontrada');
      categoriaId = cat.id;
    }

    const agg = await this.db.respuestaRapida.aggregate({ _max: { orden: true } });
    const orden = (agg._max.orden ?? 0) + 1;

    return this.db.respuestaRapida.create({
      data: {
        titulo,
        contenido,
        esPublica,
        categoriaId,
        orden,
        fijado: false,
        createdBy: actorUserId,
      },
      select: {
        id: true,
        titulo: true,
        contenido: true,
        esPublica: true,
        categoriaId: true,
        orden: true,
        fijado: true,
      },
    });
  }

  async setRespuestaRapidaFijada(actorUserId: number, id: number, fijado: boolean) {
    if (!actorUserId || actorUserId < 1) throw new BadRequestException('Usuario no válido');
    if (!Number.isFinite(id) || id < 1) throw new BadRequestException('Id inválido');

    const existing = await this.db.respuestaRapida.findFirst({
      where: { id, deletedAt: null },
      select: { id: true },
    });
    if (!existing) throw new BadRequestException('Respuesta rápida no encontrada');

    return this.db.respuestaRapida.update({
      where: { id },
      data: {
        fijado: Boolean(fijado),
        updatedBy: actorUserId,
      },
      select: {
        id: true,
        titulo: true,
        contenido: true,
        esPublica: true,
        categoriaId: true,
        orden: true,
        fijado: true,
      },
    });
  }

  async reorderRespuestasRapidas(actorUserId: number, ids: number[]) {
    if (!actorUserId || actorUserId < 1) throw new BadRequestException('Usuario no válido');
    if (!Array.isArray(ids) || ids.length === 0) throw new BadRequestException('Se requiere lista de ids');

    const normalizedIds = ids.map((id) => Number(id));
    if (normalizedIds.some((id) => !Number.isFinite(id) || id < 1)) {
      throw new BadRequestException('Lista de ids inválida');
    }
    const uniq = new Set(normalizedIds);
    if (uniq.size !== normalizedIds.length) throw new BadRequestException('La lista de ids no debe repetir valores');

    const existing = await this.db.respuestaRapida.findMany({
      where: { deletedAt: null },
      select: { id: true },
    });
    if (existing.length !== normalizedIds.length) {
      throw new BadRequestException('La lista de ids debe incluir todas las respuestas activas');
    }
    const existingIds = new Set(existing.map((r) => r.id));
    if (normalizedIds.some((id) => !existingIds.has(id))) {
      throw new BadRequestException('La lista contiene ids inexistentes');
    }

    await this.db.$transaction(
      normalizedIds.map((id, index) =>
        this.db.respuestaRapida.update({
          where: { id },
          data: {
            orden: index + 1,
            updatedBy: actorUserId,
          },
        }),
      ),
    );

    return { ok: true };
  }

  async updateRespuestaRapida(
    actorUserId: number,
    id: number,
    body: { titulo?: string; contenido?: string; categoria_id?: number | null },
  ) {
    if (!actorUserId || actorUserId < 1) throw new BadRequestException('Usuario no válido');
    if (!Number.isFinite(id) || id < 1) throw new BadRequestException('Id inválido');

    const existing = await this.db.respuestaRapida.findFirst({
      where: { id, deletedAt: null },
      select: { id: true },
    });
    if (!existing) throw new BadRequestException('Respuesta rápida no encontrada');

    const titulo = String(body?.titulo ?? '').trim();
    const contenido = String(body?.contenido ?? '').trim();
    if (!titulo) throw new BadRequestException('Se requiere titulo');
    if (!contenido) throw new BadRequestException('Se requiere contenido');

    let categoriaId: number | null = null;
    if (body?.categoria_id != null) {
      const cid = Number(body.categoria_id);
      if (!Number.isFinite(cid) || cid < 1) throw new BadRequestException('categoria_id inválido');
      const cat = await this.db.categoriaRespuesta.findFirst({
        where: { id: cid, deletedAt: null },
        select: { id: true },
      });
      if (!cat) throw new BadRequestException('Categoría no encontrada');
      categoriaId = cat.id;
    }

    return this.db.respuestaRapida.update({
      where: { id },
      data: {
        titulo,
        contenido,
        categoriaId,
        updatedBy: actorUserId,
      },
      select: {
        id: true,
        titulo: true,
        contenido: true,
        esPublica: true,
        categoriaId: true,
        orden: true,
        fijado: true,
      },
    });
  }

  async deleteRespuestaRapida(actorUserId: number, id: number) {
    if (!actorUserId || actorUserId < 1) throw new BadRequestException('Usuario no válido');
    if (!Number.isFinite(id) || id < 1) throw new BadRequestException('Id inválido');

    const existing = await this.db.respuestaRapida.findFirst({
      where: { id, deletedAt: null },
      select: { id: true },
    });
    if (!existing) throw new BadRequestException('Respuesta rápida no encontrada');

    await this.db.respuestaRapida.update({
      where: { id },
      data: {
        deletedAt: new Date(),
        deletedBy: actorUserId,
        updatedBy: actorUserId,
      },
    });

    return { ok: true };
  }

  /** Conversación “vigente” para un `wa_id`: la abierta más reciente; si todas están cerradas, la última cerrada. */
  private async findCurrentConversationForWaId(waId: string) {
    const rows = await this.db.conversacion.findMany({
      where: { waId, deletedAt: null },
      orderBy: { id: 'desc' },
      include: { estado: { select: { id: true, nombre: true } } },
    });
    if (!rows.length) return null;
    const open = rows.find((r: { estadoId: number; estado?: { nombre?: string | null } | null }) => !this.isConversationClosedRow(r));
    return open ?? rows[0];
  }

  private isConversationClosedRow(r: { estadoId: number; estado?: { nombre?: string | null } | null }): boolean {
    if (ESTADO_CONVERSACION_CERRADO_ID > 0 && r.estadoId === ESTADO_CONVERSACION_CERRADO_ID) return true;
    return normalizeStatusName(r.estado?.nombre ?? '') === 'cerrado';
  }

  /**
   * Si la última conversación del número está cerrada, crea una nueva fila (mismo wa_id, nuevo id).
   * Si no existe ninguna, crea la primera.
   */
  private async getOrCreateActiveConversationTx(
    tx: any,
    waId: string,
    profileName: string | null | undefined,
  ): Promise<{ id: number; estadoId: number }> {
    const rows = await tx.conversacion.findMany({
      where: { waId, deletedAt: null },
      orderBy: { id: 'desc' },
      include: { estado: { select: { id: true, nombre: true } } },
    });
    const latest = rows[0] ?? null;
    if (!latest) {
      return tx.conversacion.create({
        data: {
          waId,
          nombre: profileName ?? null,
          estadoId: ESTADO_CONVERSACION_ABIERTO_ID,
          estadoFlujo: 'INIT',
        },
        select: { id: true, estadoId: true },
      });
    }
    if (this.isConversationClosedRow(latest)) {
      return tx.conversacion.create({
        data: {
          waId,
          nombre: profileName ?? latest.nombre ?? null,
          estadoId: ESTADO_CONVERSACION_ABIERTO_ID,
          estadoFlujo: 'INIT',
        },
        select: { id: true, estadoId: true },
      });
    }
    if (profileName != null && String(profileName).trim() !== '') {
      await tx.conversacion.update({
        where: { id: latest.id },
        data: { nombre: String(profileName).trim() },
      });
    }
    return { id: latest.id, estadoId: latest.estadoId };
  }

  private async saveIncomingWhatsAppMessages(payload: any) {
    const entries = payload?.entry ?? [];
    const flowName = (process.env.FLOW_NAME || 'main_menu').trim() || 'main_menu';

    for (const entry of entries) {
      const changes = entry?.changes ?? [];
      for (const change of changes) {
        if (change?.field !== 'messages') continue;

        const value = change.value ?? {};
        const contacts = value?.contacts ?? [];
        const firstContact = contacts[0] ?? {};
        const profile = firstContact?.profile ?? {};

        const messages = value?.messages ?? [];
        for (const message of messages) {
          const waId = message?.from;
          const externalId = message?.id;
          const type = message?.type || 'unknown';
          const content = message?.text?.body ?? null;
          const meta = message ?? null;

          if (!waId || !externalId) continue;

          const conversation = await this.getOrCreateActiveConversationTx(
            this.db,
            waId,
            profile?.name ?? null,
          );

          // Evitar duplicados por id_externo UNIQUE.
          const created = await this.db.mensaje
            .create({
              data: {
                conversacionId: conversation.id,
                idExterno: externalId,
                enviadoPorMi: false,
                tipo: type,
                contenido: typeof content === 'string' ? content : null,
                meta: meta as any,
              },
              select: { id: true },
            })
            .then(() => true)
            .catch(() => false);

          if (created && type === 'text' && typeof content === 'string') {
            await this.processFlowAndReplySafe({
              flowName,
              conversationId: conversation.id,
              waId,
              triggerExternalId: externalId,
              incomingText: content,
            });
          }
        }
      }
    }
  }

  private async processFlowAndReplySafe(opts: {
    flowName: string;
    conversationId: number;
    waId: string;
    triggerExternalId: string;
    incomingText: string;
  }) {
    try {
      const skipFrom = (process.env.WHATSAPP_SKIP_FROM_WA_ID || '').trim();
      if (skipFrom && opts.waId === skipFrom) return;

      const normalized = normalizeText(opts.incomingText);

      const flujo = await this.db.flujo.findFirst({
        where: { nombre: opts.flowName },
        select: { id: true },
      });
      if (!flujo) return;

      const current = await this.db.conversacion.findUnique({
        where: { id: opts.conversationId },
        select: { id: true, estadoFlujo: true, cedula: true, telefono: true },
      });
      if (!current) return;

      let fromState = current.estadoFlujo || 'INIT';
      const hasCedula = Boolean(current.cedula);
      const hasTelefono = Boolean(current.telefono);
      if (fromState === 'INIT') {
        if (hasCedula && hasTelefono) fromState = 'MENU';
        else if (hasCedula && !hasTelefono) fromState = 'PEDIR_TELEFONO';
      }

      const estadoActual = await this.db.estadoFlujo.findFirst({
        where: { flujoId: flujo.id, nombreEstado: fromState },
        select: { id: true },
      });
      if (!estadoActual) return;

      // Buscar regla por texto exacto normalizado; si no, default.
      let rule = await this.db.reglaFlujo.findFirst({
        where: {
          flujoId: flujo.id,
          estadoActualId: estadoActual.id,
          tipoDisparador: 'text_equals',
          valorDisparador: normalized,
        },
        include: { siguienteEstado: { select: { nombreEstado: true } } },
      });

      if (!rule) {
        rule = await this.db.reglaFlujo.findFirst({
          where: {
            flujoId: flujo.id,
            estadoActualId: estadoActual.id,
            tipoDisparador: 'default',
            valorDisparador: null,
          },
          include: { siguienteEstado: { select: { nombreEstado: true } } },
        });
      }

      if (!rule) return;

      const nextNombreEstado = rule.siguienteEstado.nombreEstado;

      const update: { cedula?: string; telefono?: string; estadoFlujo?: string } = {};

      if (fromState === 'PEDIR_CEDULA') {
        const cedulaDigits = extractDigits(opts.incomingText);
        if (cedulaDigits.length < 6) {
          await this.sendAndPersistOutgoing({
            conversationId: opts.conversationId,
            waId: opts.waId,
            text: 'No pude leer la cédula. Envíala solo con números (ej: 12345678).',
            meta: { kind: 'validation', state: fromState },
          });
          return;
        }
        update.cedula = cedulaDigits;
      }

      if (fromState === 'PEDIR_TELEFONO') {
        const telefonoDigits = extractDigits(opts.incomingText);
        if (telefonoDigits.length < 7) {
          await this.sendAndPersistOutgoing({
            conversationId: opts.conversationId,
            waId: opts.waId,
            text: 'No pude leer el teléfono. Envíalo solo con números (ej: 04123456789).',
            meta: { kind: 'validation', state: fromState },
          });
          return;
        }
        update.telefono = telefonoDigits;
      }

      const apiJson = await this.sendWhatsAppText({ toWaId: opts.waId, text: rule.textoRespuesta });
      const outgoingExternalId =
        (apiJson as any)?.messages?.[0]?.id ??
        `local-out-${Date.now()}-${Math.random().toString(16).slice(2)}`;

      await this.db.mensaje.create({
        data: {
          conversacionId: opts.conversationId,
          idExterno: String(outgoingExternalId),
          enviadoPorMi: true,
          tipo: 'text',
          contenido: rule.textoRespuesta,
          meta: { outgoing: true, api: apiJson } as any,
        },
      });

      update.estadoFlujo = nextNombreEstado;

      await this.db.conversacion.update({
        where: { id: opts.conversationId },
        data: update,
      });
    } catch (err) {
      this.logger.error('Error procesando flujo (state machine)', err as any);
    }
  }

  private async sendAndPersistOutgoing(opts: {
    conversationId: number;
    waId: string;
    text: string;
    meta?: Record<string, unknown>;
  }) {
    const apiJson = await this.sendWhatsAppText({ toWaId: opts.waId, text: opts.text });
    const outgoingExternalId =
      (apiJson as any)?.messages?.[0]?.id ??
      `local-out-${Date.now()}-${Math.random().toString(16).slice(2)}`;

    await this.db.mensaje.create({
      data: {
        conversacionId: opts.conversationId,
        idExterno: String(outgoingExternalId),
        enviadoPorMi: true,
        tipo: 'text',
        contenido: opts.text,
        meta: { outgoing: true, api: apiJson, ...opts.meta } as any,
      },
    });
  }

  /**
   * Envía texto por WhatsApp Cloud API (Graph).
   * Si no hay `WHATSAPP_ACCESS_TOKEN` / `WHATSAPP_PHONE_NUMBER_ID` (como en desarrollo local),
   * no lanza: devuelve un objeto compatible para que el mensaje se guarde en BD con id local
   * (misma idea que en FOMAGPRUEBACHAT cuando no hay credenciales).
   */
  private async sendWhatsAppText({ toWaId, text }: { toWaId: string; text: string }) {
    if (!this.hasWhatsAppEnv()) {
      if (!ChatbotService.warnedMissingWhatsAppEnv) {
        ChatbotService.warnedMissingWhatsAppEnv = true;
        this.logger.warn(
          'WhatsApp no configurado (WHATSAPP_ACCESS_TOKEN / WHATSAPP_PHONE_NUMBER_ID). ' +
            'Los mensajes salientes se registran solo en base de datos; no se envían a Meta.',
        );
      }
      const localId = `local-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      return {
        messages: [{ id: localId }],
        skipped: true,
        reason: 'missing_whatsapp_env',
        to: toWaId,
        text,
      };
    }

    const accessToken = String(process.env.WHATSAPP_ACCESS_TOKEN).trim();
    const phoneNumberId = String(process.env.WHATSAPP_PHONE_NUMBER_ID).trim();

    const payload = {
      messaging_product: 'whatsapp',
      to: toWaId,
      type: 'text',
      text: { body: text },
    };

    // Mismo enfoque que FOMAGPRUEBACHAT: access_token en la URL.
    const url = `https://graph.facebook.com/v20.0/${encodeURIComponent(
      phoneNumberId,
    )}/messages?access_token=${encodeURIComponent(accessToken)}`;

    const apiRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const apiJson = await apiRes.json().catch(() => ({}));
    if (!apiRes.ok) {
      this.logger.error('Error WhatsApp API', { status: apiRes.status, apiJson });
      throw new Error('Error enviando mensaje con WhatsApp');
    }
    return apiJson;
  }

  private hasWhatsAppEnv(): boolean {
    const token = String(process.env.WHATSAPP_ACCESS_TOKEN ?? '').trim();
    const phoneId = String(process.env.WHATSAPP_PHONE_NUMBER_ID ?? '').trim();
    return Boolean(token && phoneId);
  }
}

function normalizeText(text: string) {
  return String(text)
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ');
}

function normalizeStatusName(value?: string) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, '_');
}

function extractDigits(text: string) {
  return String(text ?? '').replace(/\D/g, '');
}

function clampInt(value: number, min: number, max: number, fallback: number) {
  const n = Number.isFinite(value) ? Math.trunc(value) : fallback;
  return Math.max(min, Math.min(max, n));
}

