import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

type VerifyWebhookQuery = Record<string, unknown>;

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

    const conversations = await this.db.conversacion.findMany({
      take,
      orderBy: { updatedAt: 'desc' },
      include: {
        mensajes: {
          take: 1,
          orderBy: { id: 'desc' },
          select: { tipo: true, contenido: true, createdAt: true },
        },
      },
    });

    return conversations.map((c) => {
      const last = c.mensajes[0] ?? null;
      return {
        conversation_id: c.id,
        wa_id: c.waId,
        name: c.nombre,
        status: c.estado,
        last_type: last?.tipo ?? null,
        last_content: last?.contenido ?? null,
        last_created_at: last?.createdAt ?? null,
      };
    });
  }

  async getMessages({ waId, limit }: { waId: string; limit: number }) {
    const take = clampInt(limit, 1, 200, 50);

    const conversation = await this.db.conversacion.findUnique({
      where: { waId },
      select: { id: true },
    });

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

  async reply(body: { toWaId?: string; text?: string }) {
    const toWaId = String(body?.toWaId ?? '').trim();
    const text = String(body?.text ?? '').trim();

    if (!toWaId || !text) {
      throw new BadRequestException('Se requiere { toWaId, text }');
    }

    const apiJson = await this.sendWhatsAppText({ toWaId, text });

    const conversation = await this.db.conversacion.upsert({
      where: { waId: toWaId },
      create: { waId: toWaId, nombre: null, estado: 'abierto' },
      update: {},
      select: { id: true },
    });

    const externalId =
      (apiJson as any)?.messages?.[0]?.id ??
      `local-${Date.now()}-${Math.random().toString(16).slice(2)}`;

    await this.db.mensaje.create({
      data: {
        conversacionId: conversation.id,
        idExterno: String(externalId),
        enviadoPorMi: true,
        tipo: 'text',
        contenido: text,
        meta: { outgoing: true, api: apiJson } as any,
      },
    });

    return { ok: true, api: apiJson };
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

          const conversation = await this.db.conversacion.upsert({
            where: { waId },
            create: {
              waId,
              nombre: profile?.name ?? null,
              estado: 'abierto',
              estadoFlujo: 'INIT',
            },
            update: {
              nombre: profile?.name ?? undefined,
            },
            select: { id: true },
          });

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

      await this.db.historialEstadoConversacion.create({
        data: {
          conversacionId: opts.conversationId,
          estadoAnterior: fromState,
          estadoNuevo: nextNombreEstado,
          idMensajeDisparador: opts.triggerExternalId,
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

function extractDigits(text: string) {
  return String(text ?? '').replace(/\D/g, '');
}

function clampInt(value: number, min: number, max: number, fallback: number) {
  const n = Number.isFinite(value) ? Math.trunc(value) : fallback;
  return Math.max(min, Math.min(max, n));
}

