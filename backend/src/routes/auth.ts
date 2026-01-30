import { z } from 'zod';

import type { FastifyInstance } from 'fastify';

export async function authRoutes(fastify: FastifyInstance) {
  fastify.post('/auth/register', async (request, reply) => {
    const schema = z.object({
      name: z.string(),
      email: z.string().email(),
      role: z.enum(['CLIENT', 'HOST', 'ADMIN']).default('CLIENT'),
    });

    const body = schema.parse(request.body);

    const user = await fastify.prisma.user.create({
      data: {
        name: body.name,
        email: body.email,
        role: body.role,
        wallet: { create: { balance: 0 } },
        host: body.role === 'HOST' ? { create: { displayName: body.name } } : undefined,
      },
      include: { host: true },
    });

    return reply.send({
      user,
      userId: user.id,
      role: user.role,
      hostProfileId: user.host?.id ?? null,
    });
  });

  fastify.post('/auth/login', async (request, reply) => {
    const schema = z.object({
      email: z.string().email(),
    });

    const body = schema.parse(request.body);
    const user = await fastify.prisma.user.findUnique({
      where: { email: body.email },
      include: { wallet: true, host: true },
    });

    if (!user) {
      return reply.status(401).send({ error: 'Usuário não encontrado' });
    }

    return reply.send({
      token: 'mock-token',
      user,
      userId: user.id,
      role: user.role,
      hostProfileId: user.host?.id ?? null,
    });
  });
}
