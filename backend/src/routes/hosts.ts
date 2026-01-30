import { z } from 'zod';

import { registerHeartbeat } from '../services/hostHeartbeat.js';
import { requireUser } from '../utils/auth.js';

import type { FastifyInstance } from 'fastify';

export async function hostRoutes(fastify: FastifyInstance) {
  fastify.get('/hosts', async () => {
    return fastify.prisma.hostProfile.findMany({
      include: { pcs: true, user: true },
    });
  });

  fastify.post('/hosts', async (request, reply) => {
    const schema = z.object({
      displayName: z.string(),
    });

    const body = schema.parse(request.body);
    const user = await requireUser(request, reply, fastify.prisma);
    if (!user) return;

    const hostProfile = await fastify.prisma.hostProfile.upsert({
      where: { userId: user.id },
      update: { displayName: body.displayName },
      create: { userId: user.id, displayName: body.displayName },
    });

    if (user.role !== 'HOST') {
      await fastify.prisma.user.update({
        where: { id: user.id },
        data: { role: 'HOST' },
      });
    }

    return reply.send({
      hostProfile,
      hostProfileId: hostProfile.id,
    });
  });

  fastify.post('/hosts/:id/heartbeat', async (request, reply) => {
    const paramsSchema = z.object({ id: z.string() });
    const params = paramsSchema.parse(request.params);

    const bodySchema = z.object({
      status: z.enum(['ONLINE', 'OFFLINE', 'BUSY']).optional(),
    });
    const body = bodySchema.parse(request.body ?? {});
    const user = await requireUser(request, reply, fastify.prisma);
    if (!user) return;
    if (!user.host || user.host.id !== params.id) {
      return reply.status(403).send({ error: 'Sem permissao' });
    }

    await registerHeartbeat({
      prisma: fastify.prisma,
      hostId: params.id,
      status: body.status,
    });

    return { ok: true };
  });
}
