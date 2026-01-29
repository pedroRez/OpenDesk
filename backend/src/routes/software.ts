import { z } from 'zod';

import type { FastifyInstance } from 'fastify';

export async function softwareRoutes(fastify: FastifyInstance) {
  fastify.get('/software', async () => {
    return fastify.prisma.software.findMany();
  });

  fastify.post('/software', async (request) => {
    const schema = z.object({ name: z.string(), category: z.string() });
    const body = schema.parse(request.body);
    return fastify.prisma.software.create({ data: body });
  });

  fastify.post('/pcs/:id/software', async (request) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const schema = z.object({ softwareId: z.string() });
    const body = schema.parse(request.body);

    return fastify.prisma.pCSoftware.create({
      data: { pcId: params.id, softwareId: body.softwareId },
    });
  });
}
