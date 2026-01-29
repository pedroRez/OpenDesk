import { z } from 'zod';

import type { FastifyInstance } from 'fastify';

export async function pcRoutes(fastify: FastifyInstance) {
  fastify.get('/pcs', async () => {
    return fastify.prisma.pC.findMany({
      include: { softwareLinks: { include: { software: true } }, host: true },
    });
  });

  fastify.get('/pcs/:id', async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const pc = await fastify.prisma.pC.findUnique({
      where: { id: params.id },
      include: { softwareLinks: { include: { software: true } }, host: true },
    });

    if (!pc) {
      return reply.status(404).send({ error: 'PC não encontrado' });
    }

    return pc;
  });

  fastify.post('/pcs', async (request) => {
    const schema = z.object({
      hostId: z.string(),
      name: z.string(),
      level: z.enum(['A', 'B', 'C']),
      cpu: z.string(),
      ramGb: z.number(),
      gpu: z.string(),
      vramGb: z.number(),
      storageType: z.string(),
      internetUploadMbps: z.number(),
      pricePerHour: z.number(),
    });

    const body = schema.parse(request.body);

    return fastify.prisma.pC.create({
      data: body,
    });
  });

  fastify.put('/pcs/:id', async (request) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const schema = z.object({
      name: z.string().optional(),
      level: z.enum(['A', 'B', 'C']).optional(),
      cpu: z.string().optional(),
      ramGb: z.number().optional(),
      gpu: z.string().optional(),
      vramGb: z.number().optional(),
      storageType: z.string().optional(),
      internetUploadMbps: z.number().optional(),
      pricePerHour: z.number().optional(),
      status: z.enum(['ONLINE', 'OFFLINE', 'BUSY']).optional(),
    });

    const body = schema.parse(request.body);

    return fastify.prisma.pC.update({
      where: { id: params.id },
      data: body,
    });
  });

  fastify.delete('/pcs/:id', async (request) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    await fastify.prisma.pC.delete({ where: { id: params.id } });
    return { ok: true };
  });
}
