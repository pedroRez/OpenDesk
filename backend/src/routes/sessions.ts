import { z } from 'zod';
import { SessionStatus } from '@prisma/client';

import { endSession, startSession, createSession, SessionError } from '../services/sessionService.js';
import { requireUser } from '../utils/auth.js';

import type { FastifyInstance } from 'fastify';

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
      return reply.send({ session });
    } catch (error) {
      if (error instanceof SessionError) {
        return reply.status(error.status).send({ error: error.message, code: error.code });
      }

      const message = error instanceof Error ? error.message : 'Erro ao iniciar sessao';
      return reply.status(400).send({ error: message });
    }
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
