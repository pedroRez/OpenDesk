import { z } from 'zod';

import type { FastifyInstance } from 'fastify';

export async function hostRoutes(fastify: FastifyInstance) {
  fastify.get('/hosts', async () => {
    return fastify.prisma.hostProfile.findMany({
      include: { pcs: true, user: true },
    });
  });

  fastify.post('/hosts', async (request) => {
    const schema = z.object({
      userId: z.string(),
      displayName: z.string(),
    });

    const body = schema.parse(request.body);

    return fastify.prisma.hostProfile.create({
      data: {
        userId: body.userId,
        displayName: body.displayName,
      },
    });
  });

  fastify.post('/hosts/:id/heartbeat', async (request) => {
    const paramsSchema = z.object({ id: z.string() });
    const params = paramsSchema.parse(request.params);

    const bodySchema = z.object({
      status: z.enum(['ONLINE', 'OFFLINE', 'BUSY']).default('ONLINE'),
    });
    const body = bodySchema.parse(request.body ?? {});

    await fastify.prisma.pC.updateMany({
      where: { hostId: params.id },
      data: { status: body.status },
    });

    return { ok: true };
  });
}
