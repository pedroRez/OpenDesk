import { z } from 'zod';
import { SessionStatus } from '@prisma/client';
import { randomBytes } from 'crypto';

import { endSession, startSession, createSession, SessionError } from '../services/sessionService.js';
import { requireUser } from '../utils/auth.js';
import { deriveStreamId } from '../utils/streamIdentity.js';

import type { FastifyInstance, FastifyRequest } from 'fastify';
const extractForwardedIp = (value: string | string[] | undefined): string | null => {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return null;
  const parts = raw.split(',').map((part) => part.trim()).filter(Boolean);
  const first = parts.find((part) => part.toLowerCase() !== 'unknown');
  return first ?? null;
};

const getClientIp = (request: FastifyRequest): string | null => {
  return extractForwardedIp(request.headers['x-forwarded-for']) ?? request.ip ?? null;
};

const STREAM_TOKEN_TTL_MS = 60_000;
const DEFAULT_INPUT_PORT = 5505;
const DEFAULT_VIDEO_PORT = 5004;
const STREAMABLE_SESSION_STATUSES = new Set<SessionStatus>([SessionStatus.PENDING, SessionStatus.ACTIVE]);

function isStreamableStatus(status: SessionStatus): boolean {
  return STREAMABLE_SESSION_STATUSES.has(status);
}

function generateStreamToken(): string {
  return randomBytes(24).toString('base64url');
}

function parseConnectAddress(connectAddress?: string | null): { host: string | null; port: number | null } {
  const raw = connectAddress?.trim();
  if (!raw) {
    return { host: null, port: null };
  }

  if (raw.startsWith('[')) {
    const closingIndex = raw.indexOf(']');
    if (closingIndex > 0 && raw[closingIndex + 1] === ':') {
      const host = raw.slice(1, closingIndex).trim();
      const portValue = Number.parseInt(raw.slice(closingIndex + 2), 10);
      if (host && Number.isFinite(portValue) && portValue > 0 && portValue <= 65535) {
        return { host, port: portValue };
      }
    }
  }

  const lastColon = raw.lastIndexOf(':');
  if (lastColon <= 0 || lastColon === raw.length - 1) {
    return { host: raw, port: null };
  }

  const host = raw.slice(0, lastColon).trim();
  const portValue = Number.parseInt(raw.slice(lastColon + 1), 10);
  if (!host || !Number.isFinite(portValue) || portValue <= 0 || portValue > 65535) {
    return { host: raw, port: null };
  }

  return { host, port: portValue };
}

function resolveRelayWebSocketUrl(request: FastifyRequest): string {
  const rawForwardedProto = request.headers['x-forwarded-proto'];
  const forwardedProto = Array.isArray(rawForwardedProto) ? rawForwardedProto[0] : rawForwardedProto;
  const isSecure = typeof forwardedProto === 'string'
    ? forwardedProto.toLowerCase().split(',')[0].trim() === 'https'
    : request.protocol === 'https';
  const wsProtocol = isSecure ? 'wss' : 'ws';

  const rawForwardedHost = request.headers['x-forwarded-host'];
  const forwardedHost = Array.isArray(rawForwardedHost) ? rawForwardedHost[0] : rawForwardedHost;
  const host = (forwardedHost ?? request.headers.host ?? `localhost:${request.socket.localPort ?? 3333}`).trim();
  return `${wsProtocol}://${host}/stream/relay`;
}

export async function sessionRoutes(fastify: FastifyInstance) {
  fastify.post('/sessions', async (request, reply) => {
    const schema = z.object({
      pcId: z.string(),
      clientUserId: z.string(),
      minutesPurchased: z.number().min(1).max(240),
    });

    const body = schema.parse(request.body);
    const user = await requireUser(request, reply, fastify.prisma);
    if (!user) return;
    if (body.clientUserId !== user.id) {
      return reply.status(403).send({ error: 'Sem permissao' });
    }
    const header = request.headers['x-dev-bypass-credits'];
    const headerValue = Array.isArray(header) ? header[0] : header;
    const allowDevBypass = process.env.NODE_ENV !== 'production' && headerValue === 'true';

    try {
      const session = await createSession({
        prisma: fastify.prisma,
        pcId: body.pcId,
        clientId: body.clientUserId,
        minutesPurchased: body.minutesPurchased,
        bypassCredits: allowDevBypass,
      });

      return reply.status(201).send({ session, code: 'SESSION_CREATED' });
    } catch (error) {
      if (error instanceof SessionError) {
        return reply.status(error.status).send({ error: error.message, code: error.code });
      }

      const message = error instanceof Error ? error.message : 'Erro ao criar sessao';
      return reply.status(400).send({ error: message });
    }
  });

  fastify.post('/sessions/:id/start', async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const clientIp = getClientIp(request);
    const user = await requireUser(request, reply, fastify.prisma);
    if (!user) return;

    const sessionRecord = await fastify.prisma.session.findUnique({ where: { id: params.id } });
    if (!sessionRecord) {
      return reply.status(404).send({ error: 'Sessao nao encontrada' });
    }
    if (sessionRecord.clientUserId !== user.id) {
      return reply.status(403).send({ error: 'Sem permissao' });
    }

    try {
      const session = await startSession({ prisma: fastify.prisma, sessionId: params.id });
      if (clientIp) {
        await fastify.prisma.session.updateMany({
          where: { id: params.id, clientIp: null },
          data: { clientIp },
        });
      }
      return reply.send({ session });
    } catch (error) {
      if (error instanceof SessionError) {
        return reply.status(error.status).send({ error: error.message, code: error.code });
      }

      const message = error instanceof Error ? error.message : 'Erro ao iniciar sessao';
      return reply.status(400).send({ error: message });
    }
  });

  fastify.post('/sessions/:id/stream/start', async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const user = await requireUser(request, reply, fastify.prisma);
    if (!user) return;

    const sessionRecord = await fastify.prisma.session.findUnique({
      where: { id: params.id },
      include: {
        pc: {
          select: {
            id: true,
            hostId: true,
            name: true,
            connectAddress: true,
            connectHint: true,
            connectionHost: true,
            connectionPort: true,
          },
        },
      },
    });
    if (!sessionRecord) {
      return reply.status(404).send({ error: 'Sessao nao encontrada' });
    }

    const isClientOwner = sessionRecord.clientUserId === user.id;
    const isHostOwner = Boolean(user.host && user.host.id === sessionRecord.pc.hostId);
    if (!isClientOwner && !isHostOwner) {
      return reply.status(403).send({ error: 'Sem permissao' });
    }

    if (!isStreamableStatus(sessionRecord.status)) {
      return reply.status(409).send({ error: 'Sessao fora de estado de streaming', code: 'SESSION_NOT_STREAMABLE' });
    }

    let effectiveSession = sessionRecord;
    let streamState: 'STARTING' | 'ACTIVE' = sessionRecord.status === SessionStatus.PENDING ? 'STARTING' : 'ACTIVE';
    if (sessionRecord.status === SessionStatus.PENDING) {
      try {
        const started = await startSession({ prisma: fastify.prisma, sessionId: sessionRecord.id });
        effectiveSession = {
          ...sessionRecord,
          status: started.status,
          startAt: started.startAt,
          endAt: started.endAt,
          pcId: started.pcId,
          clientUserId: started.clientUserId,
          minutesPurchased: started.minutesPurchased,
          minutesUsed: started.minutesUsed,
          priceTotal: started.priceTotal,
          platformFee: started.platformFee,
          hostPayout: started.hostPayout,
          clientCredit: started.clientCredit,
          failureReason: started.failureReason,
          createdAt: started.createdAt,
          clientIp: started.clientIp,
        };
        streamState = 'ACTIVE';
      } catch (error) {
        if (error instanceof SessionError && error.code === 'INVALID_STATUS') {
          const latest = await fastify.prisma.session.findUnique({
            where: { id: sessionRecord.id },
            include: {
              pc: {
                select: {
                  id: true,
                  hostId: true,
                  name: true,
                  connectAddress: true,
                  connectHint: true,
                  connectionHost: true,
                  connectionPort: true,
                },
              },
            },
          });
          if (latest) {
            effectiveSession = latest;
            streamState = latest.status === SessionStatus.ACTIVE ? 'ACTIVE' : 'STARTING';
          }
        } else if (error instanceof SessionError) {
          return reply.status(error.status).send({ error: error.message, code: error.code });
        } else {
          return reply.status(400).send({
            error: error instanceof Error ? error.message : 'Erro ao preparar sessao para streaming',
          });
        }
      }
    }

    if (!isStreamableStatus(effectiveSession.status)) {
      return reply.status(409).send({ error: 'Sessao fora de estado de streaming', code: 'SESSION_NOT_STREAMABLE' });
    }

    const now = new Date();
    let tokenRecord = await fastify.prisma.streamConnectToken.findFirst({
      where: {
        pcId: effectiveSession.pcId,
        userId: effectiveSession.clientUserId,
        consumedAt: null,
        expiresAt: { gt: now },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!tokenRecord) {
      tokenRecord = await fastify.prisma.streamConnectToken.create({
        data: {
          token: generateStreamToken(),
          pcId: effectiveSession.pcId,
          userId: effectiveSession.clientUserId,
          expiresAt: new Date(now.getTime() + STREAM_TOKEN_TTL_MS),
        },
      });
    }

    const fallbackHost = effectiveSession.pc.connectionHost ?? parseConnectAddress(effectiveSession.pc.connectAddress).host;
    const fallbackPort = effectiveSession.pc.connectionPort ?? parseConnectAddress(effectiveSession.pc.connectAddress).port;
    if (!fallbackHost) {
      return reply.status(409).send({
        error: 'PC sem host de conexao publicado.',
        code: 'MISSING_HOST_ADDRESS',
      });
    }

    const videoPort = Number.isFinite(fallbackPort ?? NaN) && (fallbackPort ?? 0) > 0
      ? (fallbackPort as number)
      : DEFAULT_VIDEO_PORT;
    const streamId = deriveStreamId(tokenRecord.token);
    const relayUrl = resolveRelayWebSocketUrl(request);

    return reply.send({
      sessionId: effectiveSession.id,
      sessionStatus: effectiveSession.status,
      streamState,
      host: fallbackHost,
      videoPort,
      inputPort: DEFAULT_INPUT_PORT,
      streamId,
      token: tokenRecord.token,
      tokenExpiresAt: tokenRecord.expiresAt.toISOString(),
      connectAddress: `${fallbackHost}:${videoPort}`,
      transport: {
        recommended: 'UDP_LAN',
        relay: {
          mode: 'RELAY_WS',
          url: relayUrl,
          roleClient: 'client',
          roleHost: 'host',
          sessionId: effectiveSession.id,
          streamId,
          token: tokenRecord.token,
          tokenExpiresAt: tokenRecord.expiresAt.toISOString(),
        },
        lan: {
          mode: 'UDP_LAN',
          host: fallbackHost,
          videoPort,
          inputPort: DEFAULT_INPUT_PORT,
        },
      },
      fallback: {
        provider: 'SUNSHINE_MOONLIGHT',
        connectAddress: `${fallbackHost}:${videoPort}`,
        connectHint: effectiveSession.pc.connectHint ?? null,
      },
    });
  });

  fastify.post('/sessions/:id/end', async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const body = z
      .object({
        failureReason: z.enum(['HOST', 'CLIENT', 'PLATFORM', 'NONE']).optional(),
        hostFault: z.boolean().optional(),
      })
      .parse(request.body ?? {});
    const user = await requireUser(request, reply, fastify.prisma);
    if (!user) return;

    const sessionRecord = await fastify.prisma.session.findUnique({ where: { id: params.id } });
    if (!sessionRecord) {
      return reply.status(404).send({ error: 'Sessao nao encontrada' });
    }
    if (sessionRecord.clientUserId !== user.id) {
      return reply.status(403).send({ error: 'Sem permissao' });
    }

    try {
      const session = await endSession({
        prisma: fastify.prisma,
        sessionId: params.id,
        failureReason: body.failureReason,
        hostFault: body.hostFault,
      });
      return reply.send({ session });
    } catch (error) {
      if (error instanceof SessionError) {
        return reply.status(error.status).send({ error: error.message, code: error.code });
      }

      const message = error instanceof Error ? error.message : 'Erro ao encerrar sessao';
      return reply.status(400).send({ error: message });
    }
  });

  fastify.get('/sessions/:id', async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const clientIp = getClientIp(request);
    const user = await requireUser(request, reply, fastify.prisma);
    if (!user) return;

    const session = await fastify.prisma.session.findUnique({
      where: { id: params.id },
      include: { pc: true },
    });

    if (!session) {
      return reply.status(404).send({ error: 'Sessao nao encontrada' });
    }

    if (session.clientUserId !== user.id) {
      return reply.status(403).send({ error: 'Sem permissao' });
    }

    const minutesUsed =
      session.status === SessionStatus.ACTIVE && session.startAt
        ? Math.min(
            session.minutesPurchased,
            Math.max(0, Math.ceil((Date.now() - session.startAt.getTime()) / 60000)),
          )
        : session.minutesUsed;

    return reply.send({
      session: {
        ...session,
        minutesUsed,
      },
    });
  });
}




