import { BadRequestException, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
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

const CHATBOT_SYSTEM_USER_ID =
  Number(process.env.CHATBOT_SYSTEM_USER_ID ?? process.env.CHATBOT_PUBLIC_REPLY_USER_ID ?? 1) > 0
    ? Number(process.env.CHATBOT_SYSTEM_USER_ID ?? process.env.CHATBOT_PUBLIC_REPLY_USER_ID ?? 1)
    : 1;

/**
 * Usuario al que se asigna la conversación cuando el visitante termina el flujo del bot
 * (estado de flujo `esperando_asesor`). Mientras el bot recopila datos, `current_user_id` queda en null.
 */
const CHATBOT_AUTO_ASSIGN_USER_ID =
  Number(process.env.CHATBOT_AUTO_ASSIGN_USER_ID ?? 32) > 0 ? Number(process.env.CHATBOT_AUTO_ASSIGN_USER_ID ?? 32) : 32;

const ETIQUETA_CONVERSACION_ESCALADA = 'Escalado';
const ETIQUETA_CONVERSACION_ESCALADA_COLOR = '#FED7AA';

/** Estados en los que el bot ya no procesa mensajes automáticos. */
const FLOW_TERMINAL_STATES = new Set(['flujo_finalizado', 'finalizado', 'esperando_asesor']);

const FLOW_INACTIVITY_WARN_MS =
  (Number(process.env.FLOW_INACTIVITY_WARN_MINUTES) > 0
    ? Number(process.env.FLOW_INACTIVITY_WARN_MINUTES)
    : 5) *
  60 *
  1000;

const FLOW_INACTIVITY_CLOSE_MS =
  (Number(process.env.FLOW_INACTIVITY_CLOSE_MINUTES) > 0
    ? Number(process.env.FLOW_INACTIVITY_CLOSE_MINUTES)
    : 7) *
  60 *
  1000;

const FLOW_INACTIVITY_WARN_MESSAGE =
  '⏱️ Llevamos un momento sin recibir tu respuesta.\n\n' +
  'Si no continúas en los próximos 2 minutos, esta conversación se cerrará automáticamente.\n\n' +
  'Por favor, responde para seguir con tu solicitud.';

const FLOW_INACTIVITY_CLOSE_MESSAGE =
  '⏱️ Tu sesión en el chatbot expiró por inactividad.\n\n' +
  'Cuando desees, escribe de nuevo para iniciar una nueva solicitud.';

const FLOW_INACTIVITY_SWEEP_MS =
  Number(process.env.FLOW_INACTIVITY_SWEEP_MS) > 0 ? Number(process.env.FLOW_INACTIVITY_SWEEP_MS) : 60_000;

@Injectable()
export class ChatbotService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ChatbotService.name);
  private static warnedMissingWhatsAppEnv = false;
  private static warnedMissingWhapiEnv = false;
  private flowInactivityInterval: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit() {
    this.flowInactivityInterval = setInterval(() => {
      void this.sweepFlowInactivity().catch((err) => {
        this.logger.error('Error en barrido de inactividad del flujo', err as Error);
      });
    }, FLOW_INACTIVITY_SWEEP_MS);
  }

  onModuleDestroy() {
    if (this.flowInactivityInterval) {
      clearInterval(this.flowInactivityInterval);
      this.flowInactivityInterval = null;
    }
  }

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
    const p: any = payload as any;

    // Auto-detección: Meta Graph manda `entry`; Whapi suele mandar `messages` o `message`.
    if (Array.isArray(p?.entry)) {
      await this.saveIncomingWhatsAppMessages(p);
      return;
    }
    if (Array.isArray(p?.messages) || p?.message) {
      await this.saveIncomingWhapiMessages(p);
      return;
    }

    // Si llega un POST válido pero de otro formato, no insertará nada.
    this.logger.warn('Webhook recibido pero con formato no reconocido; no se insertó nada.', {
      keys: p && typeof p === 'object' ? Object.keys(p).slice(0, 20) : typeof p,
    });
  }

  /**
   * Webhook para Whapi Cloud.
   *
   * Whapi puede enviar payloads distintos a Meta (Graph). Este adaptador intenta extraer
   * mensajes de texto entrantes en estructuras comunes y reutiliza la misma lógica de
   * creación de conversación/mensaje + ejecución del flujo.
   */
  async receiveWhapiWebhook(payload: unknown): Promise<void> {
    await this.saveIncomingWhapiMessages(payload as any);
  }

  async getConversations({
    limit,
    actorUserId,
    tipoUsuario,
  }: {
    limit: number;
    actorUserId: number;
    tipoUsuario?: string | null;
  }) {
    const take = clampInt(limit, 1, 100, 50);
    const tipoFilter = normalizeConversationTipoUsuario(tipoUsuario);

    const all = await this.db.conversacion.findMany({
      where: {
        deletedAt: null,
        currentUserId: actorUserId,
      },
      orderBy: [{ id: 'desc' }],
      include: {
        estado: { select: { id: true, nombre: true } },
        currentUser: { select: { id: true, nombre: true } },
        conversacionEtiquetas: {
          where: {
            etiqueta: {
              nombre: ETIQUETA_CONVERSACION_ESCALADA,
              deletedAt: null,
            },
          },
          select: { id: true },
        },
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

    const filtered = tipoFilter
      ? conversations.filter((c) => getConversationMetadataTipoUsuario(c.metadata) === tipoFilter)
      : conversations;

    return filtered.slice(0, take).map((c) => {
      const last = c.mensajes[0] ?? null;
      const tipoUsuarioMeta = getConversationMetadataTipoUsuario(c.metadata);
      return {
        conversation_id: c.id,
        wa_id: c.waId,
        name: c.nombre,
        created_at: c.createdAt,
        fijado: Boolean(c.fijado),
        escalado: c.conversacionEtiquetas.length > 0,
        current_user_id: c.currentUser?.id ?? null,
        current_user_name: c.currentUser?.nombre ?? null,
        status: c.estado?.nombre ?? null,
        estado_id: c.estadoId,
        last_type: last?.tipo ?? null,
        last_content: last?.contenido ?? null,
        last_created_at: last?.createdAt ?? null,
        estado_flujo: c.estadoFlujo ?? null,
        metadata: c.metadata ?? null,
        tipo_usuario: tipoUsuarioMeta,
        cedula: c.cedula ?? null,
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

    await this.prisma.$transaction(async (tx: any) => {
      const conv = await this.getOrCreateActiveConversationTx(tx, toWaId, null, actorUserId);

      if (conv.estadoId === ESTADO_CONVERSACION_ABIERTO_ID) {
        await tx.conversacion.update({
          where: { id: conv.id },
          data: { estadoId: ESTADO_CONVERSACION_EN_PROGRESO_ID },
        });
        await this.registerConversationStatusChangeTx(tx, {
          conversacionId: conv.id,
          estadoAnteriorId: ESTADO_CONVERSACION_ABIERTO_ID,
          estadoNuevoId: ESTADO_CONVERSACION_EN_PROGRESO_ID,
          estadoAnteriorNombre: 'abierto',
          estadoNuevoNombre: 'en_progreso',
          motivo: 'Primer mensaje del agente desde inbox',
          actorUserId,
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

  /**
   * Inicia una conversación saliente desde el inbox: crea/actualiza la fila en BD,
   * asigna al agente, deja el flujo en `flujo_finalizado`, estado `en_progreso` y envía el primer mensaje.
   */
  async startConversation(opts: { waId?: string; text?: string; actorUserId: number }) {
    const waId = normalizeWaIdDigits(opts.waId);
    const text = String(opts.text ?? '').trim();
    const actorUserId = Number(opts.actorUserId ?? 0);

    if (!waId || waId.length < 10 || waId.length > 15) {
      throw new BadRequestException('Número de WhatsApp no válido (use prefijo país + número, solo dígitos)');
    }
    if (!text) {
      throw new BadRequestException('Se requiere el mensaje inicial');
    }
    if (!actorUserId || actorUserId < 1) {
      throw new BadRequestException('Usuario no válido');
    }

    const actor = await this.db.user.findFirst({
      where: { id: actorUserId, deletedAt: null },
      select: { id: true, nombre: true },
    });
    if (!actor) throw new BadRequestException('Usuario no encontrado');

    const apiJson = await this.sendWhatsAppText({ toWaId: waId, text });
    const externalId =
      (apiJson as any)?.messages?.[0]?.id ??
      `local-out-${Date.now()}-${Math.random().toString(16).slice(2)}`;

    const metadataInicio = {
      iniciada_por_agente: true,
      iniciada_por_user_id: actorUserId,
      iniciada_en: new Date().toISOString(),
    };

    let conversationId = 0;
    let previousEstadoId: number | null = null;
    let previousEstadoNombre: string | null = null;

    await this.prisma.$transaction(async (tx: any) => {
      const rows = await tx.conversacion.findMany({
        where: { waId, deletedAt: null },
        orderBy: { id: 'desc' },
        include: { estado: { select: { id: true, nombre: true } } },
      });
      const latest = rows[0] ?? null;
      const useExistingOpen = latest != null && !this.isConversationClosedRow(latest);

      if (useExistingOpen) {
        conversationId = latest.id;
        previousEstadoId = latest.estadoId;
        previousEstadoNombre = latest.estado?.nombre ?? null;

        await tx.conversacion.update({
          where: { id: latest.id },
          data: {
            estadoId: ESTADO_CONVERSACION_EN_PROGRESO_ID,
            estadoFlujo: 'flujo_finalizado',
            currentUserId: actorUserId,
            telefono: waId,
            metadata: mergeConversationMetadata(latest.metadata, metadataInicio) as object,
          },
        });
      } else {
        const created = await tx.conversacion.create({
          data: {
            waId,
            estadoId: ESTADO_CONVERSACION_EN_PROGRESO_ID,
            estadoFlujo: 'flujo_finalizado',
            currentUserId: actorUserId,
            telefono: waId,
            metadata: metadataInicio as object,
          },
          select: { id: true, estadoId: true },
        });
        conversationId = created.id;
        previousEstadoId = null;
        previousEstadoNombre = null;

        await this.registerConversationOpenedTx(tx, {
          conversacionId: created.id,
          motivo: 'Conversación iniciada por agente desde inbox',
          actorUserId,
          estadoId: ESTADO_CONVERSACION_EN_PROGRESO_ID,
          estadoNombre: 'en_progreso',
        });
      }

      if (
        useExistingOpen &&
        previousEstadoId != null &&
        previousEstadoId !== ESTADO_CONVERSACION_EN_PROGRESO_ID
      ) {
        await this.registerConversationStatusChangeTx(tx, {
          conversacionId: conversationId,
          estadoAnteriorId: previousEstadoId,
          estadoNuevoId: ESTADO_CONVERSACION_EN_PROGRESO_ID,
          estadoAnteriorNombre: previousEstadoNombre,
          estadoNuevoNombre: 'en_progreso',
          motivo: 'Conversación iniciada por agente desde inbox',
          actorUserId,
        });
      }

      await tx.asignacionConversacion.updateMany({
        where: { conversacionId: conversationId, isActive: true },
        data: {
          isActive: false,
          unassignedAt: new Date(),
          unassignedBy: actorUserId,
        },
      });

      await tx.asignacionConversacion.create({
        data: {
          conversacionId: conversationId,
          userId: actorUserId,
          assignedBy: actorUserId,
          isActive: true,
          assignedAt: new Date(),
        },
      });

      await this.createConversationHistoryTx(tx, {
        conversacionId: conversationId,
        accion: 'INICIAR_CONVERSACION',
        descripcion: `Conversación iniciada por ${actor.nombre}`,
        valorNuevo: {
          wa_id: waId,
          estado_flujo: 'flujo_finalizado',
          estado: 'en_progreso',
          current_user_id: actorUserId,
        },
        actorUserId,
      });

      await tx.mensaje.create({
        data: {
          conversacionId: conversationId,
          idExterno: String(externalId),
          enviadoPorMi: true,
          tipo: 'text',
          contenido: text,
          meta: {
            outgoing: true,
            api: apiJson,
            source: 'inbox_iniciar_conversacion',
            agentUserId: actorUserId,
          } as object,
        },
      });
    });

    return {
      ok: true,
      conversation_id: conversationId,
      wa_id: waId,
      current_user_id: actor.id,
      current_user_name: actor.nombre,
      status: 'en_progreso',
      estado_flujo: 'flujo_finalizado',
      last_content: text,
      api: apiJson,
    };
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
      await tx.conversacion.update({
        where: { id: conversation.id },
        data: { estadoId: targetState.id },
      });
      await this.registerConversationStatusChangeTx(tx, {
        conversacionId: conversation.id,
        estadoAnteriorId: conversation.estadoId,
        estadoNuevoId: targetState.id,
        estadoAnteriorNombre: conversation.estado?.nombre ?? null,
        estadoNuevoNombre: targetState.nombre,
        motivo,
        actorUserId,
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

  async escalarConversation(opts: { waId: string; actorUserId: number }) {
    const waId = String(opts.waId ?? '').trim();
    const actorUserId = Number(opts.actorUserId ?? 0);

    if (!waId) throw new BadRequestException('Se requiere waId');
    if (!actorUserId || actorUserId < 1) throw new BadRequestException('Usuario no válido');

    const conversation = await this.findCurrentConversationForWaId(waId);
    if (!conversation) throw new BadRequestException('Conversación no encontrada');

    let alreadyEscalated = false;

    await this.db.$transaction(async (tx: any) => {
      let etiqueta = await tx.etiqueta.findUnique({
        where: { nombre: ETIQUETA_CONVERSACION_ESCALADA },
        select: { id: true, deletedAt: true },
      });

      if (!etiqueta) {
        etiqueta = await tx.etiqueta.create({
          data: {
            nombre: ETIQUETA_CONVERSACION_ESCALADA,
            color: ETIQUETA_CONVERSACION_ESCALADA_COLOR,
            descripcion: 'Conversación escalada desde inbox',
            createdBy: actorUserId,
          },
          select: { id: true, deletedAt: true },
        });
      } else if (etiqueta.deletedAt) {
        etiqueta = await tx.etiqueta.update({
          where: { id: etiqueta.id },
          data: {
            color: ETIQUETA_CONVERSACION_ESCALADA_COLOR,
            deletedAt: null,
            deletedBy: null,
            updatedBy: actorUserId,
          },
          select: { id: true, deletedAt: true },
        });
      }

      const relacionExistente = await tx.conversacionEtiqueta.findFirst({
        where: {
          conversacionId: conversation.id,
          etiquetaId: etiqueta.id,
        },
        select: { id: true },
      });

      if (relacionExistente) {
        alreadyEscalated = true;
        return;
      }

      await tx.conversacionEtiqueta.create({
        data: {
          conversacionId: conversation.id,
          etiquetaId: etiqueta.id,
          createdBy: actorUserId,
        },
      });

      await this.createConversationHistoryTx(tx, {
        conversacionId: conversation.id,
        accion: 'ESCALAR_CONVERSACION',
        descripcion: 'Conversación escalada desde inbox',
        valorNuevo: {
          etiqueta_id: etiqueta.id,
          etiqueta: ETIQUETA_CONVERSACION_ESCALADA,
          color: ETIQUETA_CONVERSACION_ESCALADA_COLOR,
        },
        actorUserId,
      });
    });

    return {
      ok: true,
      conversation_id: conversation.id,
      wa_id: conversation.waId,
      escalado: true,
      already_escalated: alreadyEscalated,
    };
  }

  async transferConversation(opts: { waId: string; userId: number; actorUserId: number }) {
    const waId = String(opts.waId ?? '').trim();
    const actorUserId = Number(opts.actorUserId ?? 0);
    const targetUserId = Number(opts.userId ?? 0);

    if (!waId) throw new BadRequestException('Se requiere waId');
    if (!actorUserId || actorUserId < 1) throw new BadRequestException('Usuario no válido');
    if (!targetUserId || targetUserId < 1) throw new BadRequestException('Usuario destino no válido');

    const conversation = await this.findCurrentConversationForWaId(waId);
    if (!conversation) throw new BadRequestException('Conversación no encontrada');

    const targetUser = await this.db.user.findFirst({
      where: { id: targetUserId, deletedAt: null },
      select: { id: true, nombre: true, cedula: true },
    });
    if (!targetUser) throw new BadRequestException('Usuario destino no encontrado');

    const activeAssignment = await this.db.asignacionConversacion.findFirst({
      where: { conversacionId: conversation.id, isActive: true },
      include: { user: { select: { id: true, nombre: true } } },
      orderBy: { id: 'desc' },
    });

    if (activeAssignment?.userId === targetUser.id && conversation.currentUserId === targetUser.id) {
      return {
        ok: true,
        conversation_id: conversation.id,
        wa_id: conversation.waId,
        current_user_id: targetUser.id,
        current_user_name: targetUser.nombre,
        already_assigned: true,
      };
    }

    const previousUserId = activeAssignment?.userId ?? conversation.currentUserId ?? null;
    const previousUserName = activeAssignment?.user?.nombre ?? null;

    await this.db.$transaction(async (tx: any) => {
      await tx.asignacionConversacion.updateMany({
        where: { conversacionId: conversation.id, isActive: true },
        data: {
          isActive: false,
          unassignedAt: new Date(),
          unassignedBy: actorUserId,
        },
      });

      await tx.asignacionConversacion.create({
        data: {
          conversacionId: conversation.id,
          userId: targetUser.id,
          assignedBy: actorUserId,
          isActive: true,
          assignedAt: new Date(),
        },
      });

      await tx.conversacion.update({
        where: { id: conversation.id },
        data: {
          currentUserId: targetUser.id,
        },
      });

      await this.createConversationHistoryTx(tx, {
        conversacionId: conversation.id,
        accion: 'TRANSFERENCIA_CONVERSACION',
        descripcion: previousUserName
          ? `Conversación transferida de ${previousUserName} a ${targetUser.nombre}`
          : `Conversación transferida a ${targetUser.nombre}`,
        valorAnterior: previousUserId
          ? {
              current_user_id: previousUserId,
              current_user_name: previousUserName,
            }
          : null,
        valorNuevo: {
          current_user_id: targetUser.id,
          current_user_name: targetUser.nombre,
        },
        actorUserId,
      });
    });

    return {
      ok: true,
      conversation_id: conversation.id,
      wa_id: conversation.waId,
      current_user_id: targetUser.id,
      current_user_name: targetUser.nombre,
      already_assigned: false,
    };
  }

  async reportConversation(opts: { waId: string; motivo?: string; descripcion?: string; detalle?: string; actorUserId: number }) {
    const waId = String(opts.waId ?? '').trim();
    const motivo = String(opts.motivo ?? '').trim();
    const descripcion = String(opts.descripcion ?? '').trim();
    const detalle = String(opts.detalle ?? '').trim();
    const actorUserId = Number(opts.actorUserId ?? 0);

    if (!waId) throw new BadRequestException('Se requiere waId');
    if (!motivo) throw new BadRequestException('Se requiere motivo');
    if (!descripcion) throw new BadRequestException('Se requiere descripcion');
    if (!actorUserId || actorUserId < 1) throw new BadRequestException('Usuario no válido');

    const conversation = await this.findCurrentConversationForWaId(waId);
    if (!conversation) throw new BadRequestException('Conversación no encontrada');

    await this.db.$transaction(async (tx: any) => {
      await this.createConversationHistoryTx(tx, {
        conversacionId: conversation.id,
        accion: 'REPORTE_CONVERSACION',
        descripcion,
        valorNuevo: {
          motivo,
          descripcion,
          detalle: detalle || null,
        },
        actorUserId,
      });
    });

    return {
      ok: true,
      conversation_id: conversation.id,
      wa_id: conversation.waId,
    };
  }

  async getUserPreferences(userId: number) {
    if (!userId || userId < 1) throw new BadRequestException('Usuario no válido');

    const prefs = await this.db.userPreference.findUnique({
      where: { userId },
      select: {
        tema: true,
        listaConversacionesOrden: true,
        lunchAt: true,
      },
    });

    return {
      tema: Boolean(prefs?.tema ?? false),
      lista_conversaciones_orden: Boolean(prefs?.listaConversacionesOrden ?? false),
      lunch_at: prefs?.lunchAt ? new Date(prefs.lunchAt).toISOString() : null,
    };
  }

  async updateUserPreferences(
    userId: number,
    body: { tema?: boolean; lista_conversaciones_orden?: boolean; lunch_at?: string | null; is_online?: boolean },
  ) {
    if (!userId || userId < 1) throw new BadRequestException('Usuario no válido');

    const data: { tema?: boolean; listaConversacionesOrden?: boolean; lunchAt?: Date | null } = {};
    if (body?.tema != null) data.tema = Boolean(body.tema);
    if (body?.lista_conversaciones_orden != null) {
      data.listaConversacionesOrden = Boolean(body.lista_conversaciones_orden);
    }
    if (Object.prototype.hasOwnProperty.call(body ?? {}, 'lunch_at')) {
      if (body?.lunch_at == null || String(body.lunch_at).trim() === '') {
        data.lunchAt = null;
      } else {
        const parsed = new Date(String(body.lunch_at));
        if (Number.isNaN(parsed.getTime())) {
          throw new BadRequestException('lunch_at inválido');
        }
        data.lunchAt = parsed;
      }
    }
    if (Object.keys(data).length === 0) {
      if (!Object.prototype.hasOwnProperty.call(body ?? {}, 'is_online')) {
        throw new BadRequestException('No hay preferencias para actualizar');
      }
    }

    const prefs = await this.db.$transaction(async (tx: any) => {
      const currentPreferences = await tx.userPreference.findUnique({
        where: { userId },
        select: { lunchAt: true },
      });

      if (data.lunchAt && currentPreferences?.lunchAt && isSameUtcDate(currentPreferences.lunchAt, data.lunchAt)) {
        throw new BadRequestException('Ya registraste tu lunch hoy. No puedes volver a activarlo hasta mañana.');
      }

      const updatedPreferences = await tx.userPreference.upsert({
        where: { userId },
        update: data,
        create: {
          userId,
          ...data,
        },
        select: {
          tema: true,
          listaConversacionesOrden: true,
          lunchAt: true,
        },
      });

      const userOnlineUpdate =
        body?.is_online != null ? Boolean(body.is_online) : Object.prototype.hasOwnProperty.call(body ?? {}, 'lunch_at') ? !data.lunchAt : null;

      if (userOnlineUpdate != null) {
        await tx.user.update({
          where: { id: userId },
          data: {
            isOnline: userOnlineUpdate,
          },
        });
      }

      return updatedPreferences;
    });

    return {
      ok: true,
      tema: Boolean(prefs.tema),
      lista_conversaciones_orden: Boolean(prefs.listaConversacionesOrden),
      lunch_at: prefs.lunchAt ? new Date(prefs.lunchAt).toISOString() : null,
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
  private async createConversationHistoryTx(
    tx: any,
    opts: {
      conversacionId: number;
      accion: string;
      descripcion?: string | null;
      valorAnterior?: Record<string, unknown> | null;
      valorNuevo?: Record<string, unknown> | null;
      actorUserId: number;
    },
  ) {
    await tx.historialConversacion.create({
      data: {
        conversacionId: opts.conversacionId,
        accion: opts.accion,
        descripcion: opts.descripcion ?? null,
        valorAnterior: (opts.valorAnterior ?? null) as any,
        valorNuevo: (opts.valorNuevo ?? null) as any,
        createdBy: opts.actorUserId,
      },
    });
  }

  private async registerConversationStatusChangeTx(
    tx: any,
    opts: {
      conversacionId: number;
      estadoAnteriorId: number;
      estadoNuevoId: number;
      estadoAnteriorNombre?: string | null;
      estadoNuevoNombre?: string | null;
      motivo: string;
      actorUserId: number;
    },
  ) {
    const valorAnterior: Record<string, unknown> = { estado_id: opts.estadoAnteriorId };
    const valorNuevo: Record<string, unknown> = { estado_id: opts.estadoNuevoId };

    if (opts.estadoAnteriorNombre) valorAnterior.estado = opts.estadoAnteriorNombre;
    if (opts.estadoNuevoNombre) valorNuevo.estado = opts.estadoNuevoNombre;

    await this.createConversationHistoryTx(tx, {
      conversacionId: opts.conversacionId,
      accion: 'CAMBIO_ESTADO',
      descripcion: opts.motivo,
      valorAnterior,
      valorNuevo,
      actorUserId: opts.actorUserId,
    });
  }

  private async registerConversationOpenedTx(
    tx: any,
    opts: {
      conversacionId: number;
      motivo: string;
      actorUserId: number;
      estadoId?: number;
      estadoNombre?: string;
    },
  ) {
    await this.createConversationHistoryTx(tx, {
      conversacionId: opts.conversacionId,
      accion: 'CAMBIO_ESTADO',
      descripcion: opts.motivo,
      valorNuevo: {
        estado_id: opts.estadoId ?? ESTADO_CONVERSACION_ABIERTO_ID,
        estado: opts.estadoNombre ?? 'abierto',
      },
      actorUserId: opts.actorUserId,
    });
  }

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
    actorUserId = CHATBOT_SYSTEM_USER_ID,
  ): Promise<{ id: number; estadoId: number }> {
    const rows = await tx.conversacion.findMany({
      where: { waId, deletedAt: null },
      orderBy: { id: 'desc' },
      include: { estado: { select: { id: true, nombre: true } } },
    });
    const latest = rows[0] ?? null;
    if (!latest) {
      const createdConversation = await tx.conversacion.create({
        data: {
          waId,
          nombre: profileName ?? null,
          estadoId: ESTADO_CONVERSACION_ABIERTO_ID,
          estadoFlujo: 'inicio',
          currentUserId: null,
        },
        select: { id: true, estadoId: true },
      });
      await this.registerConversationOpenedTx(tx, {
        conversacionId: createdConversation.id,
        motivo: 'Conversación creada automáticamente',
        actorUserId,
      });
      return createdConversation;
    }
    if (this.isConversationClosedRow(latest)) {
      const createdConversation = await tx.conversacion.create({
        data: {
          waId,
          nombre: profileName ?? latest.nombre ?? null,
          estadoId: ESTADO_CONVERSACION_ABIERTO_ID,
          estadoFlujo: 'inicio',
          currentUserId: null,
        },
        select: { id: true, estadoId: true },
      });
      await this.registerConversationOpenedTx(tx, {
        conversacionId: createdConversation.id,
        motivo: 'Conversación creada automáticamente',
        actorUserId,
      });
      return createdConversation;
    }
    const profileTrimmed = profileName != null ? String(profileName).trim() : '';
    const existingNombre = latest.nombre != null ? String(latest.nombre).trim() : '';
    if (profileTrimmed && !existingNombre) {
      await tx.conversacion.update({
        where: { id: latest.id },
        data: { nombre: profileTrimmed },
      });
    }

    return { id: latest.id, estadoId: latest.estadoId };
  }

  /** Cierra la conversación abierta del número si el flujo del bot expiró por inactividad. */
  private async expireBotFlowConversationIfNeeded(waId: string): Promise<void> {
    const conversation = await this.findCurrentConversationForWaId(waId);
    if (!conversation || this.isConversationClosedRow(conversation)) return;
    if (!isActiveBotCollectionPhase(conversation)) return;

    const lastUserMessageAt = await this.getLastUserMessageAt(conversation.id);
    if (!lastUserMessageAt) return;

    const inactiveMs = Date.now() - lastUserMessageAt.getTime();
    if (inactiveMs < FLOW_INACTIVITY_CLOSE_MS) return;

    await this.closeConversationForFlowInactivity({
      conversation: {
        id: conversation.id,
        waId: conversation.waId,
        estadoId: conversation.estadoId,
        estado: conversation.estado ?? null,
      },
      sendFarewell: true,
    });
  }

  private async getLastUserMessageAt(conversationId: number): Promise<Date | null> {
    const row = await this.db.mensaje.findFirst({
      where: { conversacionId: conversationId, enviadoPorMi: false },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    return row?.createdAt ?? null;
  }

  private async closeConversationForFlowInactivity(opts: {
    conversation: {
      id: number;
      waId: string;
      estadoId: number;
      estado?: { nombre?: string | null } | null;
    };
    motivo?: string;
    sendFarewell?: boolean;
  }) {
    if (this.isConversationClosedRow(opts.conversation)) return;

    const cerrado = await this.db.estado.findFirst({
      where: { nombre: 'cerrado' },
      select: { id: true, nombre: true },
    });
    if (!cerrado) {
      this.logger.warn('Estado "cerrado" no encontrado; no se puede cerrar por inactividad');
      return;
    }
    if (opts.conversation.estadoId === cerrado.id) return;

    const motivo = opts.motivo ?? 'Cierre automático por inactividad en el flujo del chatbot';

    await this.db.$transaction(async (tx: any) => {
      await tx.conversacion.update({
        where: { id: opts.conversation.id },
        data: { estadoId: cerrado.id },
      });
      await this.registerConversationStatusChangeTx(tx, {
        conversacionId: opts.conversation.id,
        estadoAnteriorId: opts.conversation.estadoId,
        estadoNuevoId: cerrado.id,
        estadoAnteriorNombre: opts.conversation.estado?.nombre ?? null,
        estadoNuevoNombre: cerrado.nombre,
        motivo,
        actorUserId: CHATBOT_SYSTEM_USER_ID,
      });
    });

    if (opts.sendFarewell !== false) {
      await this.sendAndPersistOutgoing({
        conversationId: opts.conversation.id,
        waId: opts.conversation.waId,
        text: FLOW_INACTIVITY_CLOSE_MESSAGE,
        meta: { kind: 'flow_inactivity_close' },
      });
    }
  }

  private async sendFlowInactivityWarning(conversation: {
    id: number;
    waId: string;
    metadata: unknown;
  }) {
    await this.sendAndPersistOutgoing({
      conversationId: conversation.id,
      waId: conversation.waId,
      text: FLOW_INACTIVITY_WARN_MESSAGE,
      meta: { kind: 'flow_inactivity_warn' },
    });
    await this.db.conversacion.update({
      where: { id: conversation.id },
      data: {
        metadata: mergeInactivityWarned(conversation.metadata) as object,
      },
    });
  }

  private async sweepFlowInactivity() {
    const rows = await this.db.conversacion.findMany({
      where: { deletedAt: null, currentUserId: null },
      include: { estado: { select: { id: true, nombre: true } } },
      orderBy: { id: 'asc' },
    });

    const now = Date.now();

    for (const conversation of rows) {
      if (this.isConversationClosedRow(conversation)) continue;
      if (!isActiveBotCollectionPhase(conversation)) continue;

      const lastUserMessageAt = await this.getLastUserMessageAt(conversation.id);
      if (!lastUserMessageAt) continue;

      const inactiveMs = now - lastUserMessageAt.getTime();

      if (inactiveMs >= FLOW_INACTIVITY_CLOSE_MS) {
        await this.closeConversationForFlowInactivity({
          conversation: {
            id: conversation.id,
            waId: conversation.waId,
            estadoId: conversation.estadoId,
            estado: conversation.estado ?? null,
          },
          sendFarewell: true,
        });
        continue;
      }

      if (inactiveMs >= FLOW_INACTIVITY_WARN_MS && !hasFlowInactivityWarning(conversation.metadata)) {
        await this.sendFlowInactivityWarning({
          id: conversation.id,
          waId: conversation.waId,
          metadata: conversation.metadata,
        });
      }
    }
  }

  private async saveIncomingWhatsAppMessages(payload: any) {
    const entries = payload?.entry ?? [];
    const flowName = (process.env.FLOW_NAME || 'soporte_horus').trim() || 'soporte_horus';

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

          await this.expireBotFlowConversationIfNeeded(waId);

          const conversation = await this.getOrCreateActiveConversationTx(
            this.db,
            waId,
            profile?.name ?? null,
            CHATBOT_SYSTEM_USER_ID,
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

  private async saveIncomingWhapiMessages(payload: any) {
    const flowName = (process.env.FLOW_NAME || 'soporte_horus').trim() || 'soporte_horus';

    // Estructura común (según docs/implementaciones): payload.messages = [...]
    const messages = Array.isArray(payload?.messages) ? payload.messages : [];
    if (!messages.length) {
      // Algunas instalaciones mandan { event, message: {...} }
      const single = payload?.message ? [payload.message] : [];
      if (!single.length) return;
      return await this.saveIncomingWhapiMessages({ messages: single });
    }

    for (const message of messages) {
      // Campos típicos: from/to/id/text/body, type
      const from = message?.from ?? message?.sender ?? message?.chat_id ?? message?.chatId ?? null;
      const externalId = message?.id ?? message?.message_id ?? message?.messageId ?? null;
      const type = String(message?.type ?? message?.message_type ?? 'unknown');
      const textBody =
        message?.text?.body ??
        message?.text ??
        message?.body ??
        message?.message?.text?.body ??
        message?.message?.text ??
        null;

      // Ignorar mensajes salientes (from_me) si viene en payload.
      const fromMe = Boolean(message?.from_me ?? message?.fromMe ?? message?.self);
      if (fromMe) continue;

      const waId = typeof from === 'string' ? from.replace(/\D/g, '') : String(from ?? '').replace(/\D/g, '');
      if (!waId) continue;

      const idExterno = String(externalId ?? '').trim() || `whapi-in-${Date.now()}-${Math.random().toString(16).slice(2)}`;

      await this.expireBotFlowConversationIfNeeded(waId);

      const conversation = await this.getOrCreateActiveConversationTx(
        this.db,
        waId,
        message?.sender_name ?? message?.profile?.name ?? message?.name ?? null,
        CHATBOT_SYSTEM_USER_ID,
      );

      const created = await this.db.mensaje
        .create({
          data: {
            conversacionId: conversation.id,
            idExterno,
            enviadoPorMi: false,
            tipo: type,
            contenido: typeof textBody === 'string' ? textBody : null,
            meta: { whapi: true, raw: message } as any,
          },
          select: { id: true },
        })
        .then(() => true)
        .catch(() => false);

      if (created && type === 'text' && typeof textBody === 'string') {
        await this.processFlowAndReplySafe({
          flowName,
          conversationId: conversation.id,
          waId,
          triggerExternalId: idExterno,
          incomingText: textBody,
        });
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

      const flujo = await this.db.flujo.findFirst({
        where: { nombre: opts.flowName },
        select: { id: true },
      });
      if (!flujo) return;

      const current = await this.db.conversacion.findUnique({
        where: { id: opts.conversationId },
        select: {
          id: true,
          estadoFlujo: true,
          cedula: true,
          telefono: true,
          metadata: true,
          currentUserId: true,
        },
      });
      if (!current) return;

      let fromState = String(current.estadoFlujo || 'inicio').trim() || 'inicio';
      if (fromState === 'INIT') fromState = 'inicio';

      if (isTerminalBotFlowState(fromState)) return;

      const estadoActual = await this.db.estadoFlujo.findFirst({
        where: { flujoId: flujo.id, nombreEstado: fromState },
        select: { id: true, nombreEstado: true },
      });
      if (!estadoActual) return;

      const rules = await this.db.reglaFlujo.findMany({
        where: { flujoId: flujo.id, estadoActualId: estadoActual.id },
        include: { siguienteEstado: { select: { nombreEstado: true } } },
        orderBy: { id: 'asc' },
      });

      const rule = pickMatchingFlowRule(rules, opts.incomingText);
      if (!rule) return;

      const nextNombreEstado = rule.siguienteEstado.nombreEstado;

      const metaPatch = buildMetadataPatchFromRule(rule, opts.incomingText);
      if (fromState === 'esperando_cedula' || fromState === 'esperando_nit') {
        const digits = extractDigits(opts.incomingText);
        if (digits.length >= 5) metaPatch.numero_documento = digits;
      }

      const mergedMeta = clearInactivityWarned(
        mergeConversationMetadata(current.metadata, metaPatch),
      );

      const update: {
        cedula?: string;
        telefono?: string;
        nombre?: string;
        estadoFlujo?: string;
        metadata?: Record<string, unknown>;
        currentUserId?: number | null;
      } = {
        estadoFlujo: nextNombreEstado,
        metadata: mergedMeta,
      };

      if (fromState === 'esperando_nombre') {
        const nombre = opts.incomingText.trim().replace(/\s+/g, ' ');
        if (nombre.length >= 3) update.nombre = nombre;
      }

      if (nextNombreEstado === 'esperando_asesor') {
        update.currentUserId = CHATBOT_AUTO_ASSIGN_USER_ID;
      }

      const td = mergedMeta.tipo_documento;
      const nd = mergedMeta.numero_documento;
      if (td === 'cedula' && nd != null && String(nd).length > 0) {
        update.cedula = String(nd).replace(/\D/g, '');
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

      await this.db.conversacion.update({
        where: { id: opts.conversationId },
        data: update,
      });

      if (nextNombreEstado === 'esperando_asesor') {
        const asesor = await this.db.user.findFirst({
          where: { id: CHATBOT_AUTO_ASSIGN_USER_ID, deletedAt: null },
          select: { nombre: true },
        });
        const nombreAsesor = (asesor?.nombre ?? '').trim() || 'tu asesor';
        const textoBienvenida = buildPostAsignacionWelcomeMessage(nombreAsesor);
        await this.sendAndPersistOutgoing({
          conversationId: opts.conversationId,
          waId: opts.waId,
          text: textoBienvenida,
          meta: { kind: 'post_asignacion_agente', agente_user_id: CHATBOT_AUTO_ASSIGN_USER_ID },
        });

        await this.db.conversacion.update({
          where: { id: opts.conversationId },
          data: { estadoFlujo: 'flujo_finalizado' },
        });
      }
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
   * Envía texto por WhatsApp.
   *
   * Prioridad:
   * - Si hay `WHAPI_TOKEN`, envía por Whapi Cloud (`WHAPI_BASE_URL`, default: https://gate.whapi.cloud).
   * - Si no, usa WhatsApp Cloud API (Graph) con `WHATSAPP_ACCESS_TOKEN` / `WHATSAPP_PHONE_NUMBER_ID`.
   *
   * Si no hay credenciales (como en desarrollo local), no lanza: devuelve un objeto compatible
   * para que el mensaje se guarde en BD con id local.
   */
  private async sendWhatsAppText({ toWaId, text }: { toWaId: string; text: string }) {
    if (this.hasWhapiEnv()) {
      return await this.sendWhapiText({ toWaId, text });
    }

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

  private hasWhapiEnv(): boolean {
    const token = String(process.env.WHAPI_TOKEN ?? '').trim();
    return Boolean(token);
  }

  private async sendWhapiText({ toWaId, text }: { toWaId: string; text: string }) {
    const baseUrl = String(process.env.WHAPI_BASE_URL ?? 'https://gate.whapi.cloud').trim() || 'https://gate.whapi.cloud';
    const token = String(process.env.WHAPI_TOKEN ?? '').trim();

    if (!token) {
      if (!ChatbotService.warnedMissingWhapiEnv) {
        ChatbotService.warnedMissingWhapiEnv = true;
        this.logger.warn('WHAPI_TOKEN no está definido; no se enviará por Whapi.');
      }
      const localId = `local-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      return {
        messages: [{ id: localId }],
        skipped: true,
        reason: 'missing_whapi_env',
        to: toWaId,
        text,
      };
    }

    const to = String(toWaId ?? '').trim().replace(/\D/g, '');
    const url = `${baseUrl.replace(/\/+$/, '')}/messages/text`;
    const payload = { to, body: text };

    const apiRes = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    });

    const apiJson = await apiRes.json().catch(() => ({}));
    if (!apiRes.ok) {
      this.logger.error('Error Whapi API', { status: apiRes.status, apiJson });
      throw new Error('Error enviando mensaje con Whapi');
    }

    // Normalizamos a una forma parecida a Meta para que el resto del código tome `.messages[0].id`.
    const messageId = (apiJson as any)?.message?.id ?? (apiJson as any)?.id ?? (apiJson as any)?.messages?.[0]?.id;
    return messageId ? { ...apiJson, messages: [{ id: String(messageId) }] } : apiJson;
  }

  private hasWhatsAppEnv(): boolean {
    const token = String(process.env.WHATSAPP_ACCESS_TOKEN ?? '').trim();
    const phoneId = String(process.env.WHATSAPP_PHONE_NUMBER_ID ?? '').trim();
    return Boolean(token && phoneId);
  }
}

function flowRulePriority(tipoDisparador: string): number {
  switch (tipoDisparador) {
    case 'texto':
    case 'text_equals':
      return 0;
    case 'regex':
      return 1;
    case 'cualquier_texto':
      return 2;
    case 'default':
      return 3;
    default:
      return 10;
  }
}

function flowRuleMatches(
  rule: { tipoDisparador: string; valorDisparador: string | null },
  incomingText: string,
): boolean {
  const trimmed = incomingText.trim();
  const normalized = normalizeText(incomingText);
  const tipo = rule.tipoDisparador;
  const val = rule.valorDisparador;

  switch (tipo) {
    case 'texto':
    case 'text_equals':
      if (val == null) return false;
      return normalized === normalizeText(val);
    case 'regex':
      if (!val) return false;
      try {
        return new RegExp(val).test(trimmed);
      } catch {
        return false;
      }
    case 'cualquier_texto':
      return val === '*' || val === '' || val == null;
    case 'default':
      return true;
    default:
      return false;
  }
}

function pickMatchingFlowRule(rules: any[], incomingText: string): any | null {
  const sorted = [...rules].sort((a, b) => {
    const pa = flowRulePriority(a.tipoDisparador);
    const pb = flowRulePriority(b.tipoDisparador);
    if (pa !== pb) return pa - pb;
    return (a.id ?? 0) - (b.id ?? 0);
  });
  for (const r of sorted) {
    if (flowRuleMatches(r, incomingText)) return r;
  }
  return null;
}

const CONVERSATION_TIPOS_USUARIO = new Set(['afiliado', 'prestador', 'externo', 'empleado']);

function normalizeConversationTipoUsuario(value?: string | null): string | null {
  const raw = String(value ?? '')
    .trim()
    .toLowerCase();
  return CONVERSATION_TIPOS_USUARIO.has(raw) ? raw : null;
}

function getConversationMetadataTipoUsuario(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  return normalizeConversationTipoUsuario((metadata as Record<string, unknown>).tipo_usuario as string);
}

function mergeConversationMetadata(prev: unknown, patch: Record<string, unknown>): Record<string, unknown> {
  const base =
    prev && typeof prev === 'object' && !Array.isArray(prev) ? { ...(prev as Record<string, unknown>) } : {};
  return { ...base, ...patch };
}

function isTerminalBotFlowState(estadoFlujo?: string | null): boolean {
  const state = String(estadoFlujo ?? '').trim();
  return FLOW_TERMINAL_STATES.has(state);
}

function isActiveBotCollectionPhase(conversation: {
  estadoFlujo?: string | null;
  currentUserId?: number | null;
}): boolean {
  if (conversation.currentUserId != null) return false;
  return !isTerminalBotFlowState(conversation.estadoFlujo);
}

function hasFlowInactivityWarning(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return false;
  const warnedAt = (metadata as Record<string, unknown>).flow_inactivity_warned_at;
  return warnedAt != null && String(warnedAt).trim() !== '';
}

function mergeInactivityWarned(metadata: unknown): Record<string, unknown> {
  return mergeConversationMetadata(metadata, {
    flow_inactivity_warned_at: new Date().toISOString(),
  });
}

function clearInactivityWarned(metadata: unknown): Record<string, unknown> {
  const next =
    metadata && typeof metadata === 'object' && !Array.isArray(metadata)
      ? { ...(metadata as Record<string, unknown>) }
      : {};
  delete next.flow_inactivity_warned_at;
  return next;
}

function buildMetadataPatchFromRule(
  rule: { payloadAccion?: unknown; tipoAccion?: string | null },
  incomingText: string,
): Record<string, unknown> {
  const accion = rule.tipoAccion ?? null;
  if (accion && accion !== 'merge_metadata') return {};

  const raw = rule.payloadAccion;
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return {};

  const payload = { ...(raw as Record<string, unknown>) };
  const motivoOpciones = payload.motivoOpciones;
  delete payload.motivoOpciones;

  if (motivoOpciones && typeof motivoOpciones === 'object' && !Array.isArray(motivoOpciones)) {
    const opt = incomingText.trim();
    const map = motivoOpciones as Record<string, string>;
    const motivo = map[opt];
    if (motivo) payload.motivo = motivo;
  }

  return payload;
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

function normalizeWaIdDigits(value?: string | null): string {
  return extractDigits(String(value ?? ''));
}

function isSameUtcDate(a: Date, b: Date) {
  return (
    a.getUTCFullYear() === b.getUTCFullYear() &&
    a.getUTCMonth() === b.getUTCMonth() &&
    a.getUTCDate() === b.getUTCDate()
  );
}

function clampInt(value: number, min: number, max: number, fallback: number) {
  const n = Number.isFinite(value) ? Math.trunc(value) : fallback;
  return Math.max(min, Math.min(max, n));
}

/** Mensaje automático al usuario cuando la conversación queda asignada a un asesor (post flujo). */
function buildPostAsignacionWelcomeMessage(nombreAgente: string): string {
  return (
    'Hola 👋, ¡espero que te encuentres muy bien!\n' +
    `Hablas con ${nombreAgente}, con gusto te atenderé 😊.\n` +
    'En este momento estamos recibiendo un alto volumen de mensajes, por lo que nuestra respuesta puede tardar un poco. Agradecemos mucho tu paciencia mientras te atendemos lo antes posible.'
  );
}

