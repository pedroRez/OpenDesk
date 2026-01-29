import { z } from 'zod';

import { endSession, startSession, createSession } from '../services/sessionService.js';

import type { FastifyInstance } from 'fastify';

export async function sessionRoutes(fastify: FastifyInstance) {
  fastify.post('/sessions', async (request, reply) => {
    const schema = z.object({
      pcId: z.string(),
      clientUserId: z.string(),
      minutesPurchased: z.number().min(1).max(240),
    });

    const body = schema.parse(request.body);

    try {
      const session = await createSession({
        prisma: fastify.prisma,
        pcId: body.pcId,
        clientUserId: body.clientUserId,
        minutesPurchased: body.minutesPurchased,
      });

      return reply.send({ session });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Erro ao criar sessão';
      return reply.status(400).send({ error: message });
    }
  });

  fastify.post('/sessions/:id/start', async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);

    try {
      const session = await startSession({ prisma: fastify.prisma, sessionId: params.id });
      return reply.send({ session });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Erro ao iniciar sessão';
      return reply.status(400).send({ error: message });
    }
  });

  fastify.post('/sessions/:id/end', async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const body = z
      .object({
        failureReason: z.string().optional(),
        hostFault: z.boolean().optional(),
      })
      .parse(request.body ?? {});

    try {
      const session = await endSession({
        prisma: fastify.prisma,
        sessionId: params.id,
        failureReason: body.failureReason,
        hostFault: body.hostFault,
      });
      return reply.send({ session });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Erro ao encerrar sessão';
      return reply.status(400).send({ error: message });
    }
  });

  fastify.get('/sessions/:id', async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);

    const session = await fastify.prisma.session.findUnique({
      where: { id: params.id },
      include: { pc: true },
    });

    if (!session) {
      return reply.status(404).send({ error: 'Sessão não encontrada' });
    }

    return reply.send({ session });
  });
}
