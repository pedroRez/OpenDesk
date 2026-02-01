import { z } from 'zod';
import { PCStatus } from '@prisma/client';

import type { FastifyInstance } from 'fastify';

import { requireUser } from '../utils/auth.js';

export async function pcRoutes(fastify: FastifyInstance) {
  fastify.get('/pcs', async (request) => {
    const query = z
      .object({
        status: z.enum(['ONLINE', 'OFFLINE', 'BUSY']).optional(),
      })
      .parse(request.query ?? {});

    return fastify.prisma.pC.findMany({
      where: query.status ? { status: query.status as PCStatus } : undefined,
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

  fastify.post('/pcs', async (request, reply) => {
    const schema = z.object({
      hostId: z.string().optional(),
      name: z.string(),
      level: z.enum(['A', 'B', 'C']),
      cpu: z.string(),
      ramGb: z.number(),
      gpu: z.string(),
      vramGb: z.number(),
      storageType: z.string(),
      internetUploadMbps: z.number(),
      connectionHost: z.string().min(1).optional(),
      connectionPort: z.number().int().min(1).max(65535).optional(),
      connectionNotes: z.string().max(200).optional(),
      pricePerHour: z.number(),
    });

    const body = schema.parse(request.body);
    const user = await requireUser(request, reply, fastify.prisma);
    if (!user) return;
    if (!user.host) {
      return reply.status(403).send({ error: 'Usuario nao e host' });
    }

    if (body.hostId && body.hostId !== user.host.id) {
      return reply.status(403).send({ error: 'Host invalido' });
    }

    const { hostId: _hostId, ...payload } = body;
    return fastify.prisma.pC.create({
      data: {
        ...payload,
        hostId: user.host.id,
        connectionPort: body.connectionPort ?? 47990,
      },
    });
  });

  fastify.put('/pcs/:id', async (request, reply) => {
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
      connectionHost: z.string().min(1).optional(),
      connectionPort: z.number().int().min(1).max(65535).optional(),
      connectionNotes: z.string().max(200).optional(),
      pricePerHour: z.number().optional(),
      status: z.enum(['ONLINE', 'OFFLINE', 'BUSY']).optional(),
    });

    const body = schema.parse(request.body);
    const user = await requireUser(request, reply, fastify.prisma);
    if (!user) return;
    if (!user.host) {
      return reply.status(403).send({ error: 'Usuario nao e host' });
    }

    const pc = await fastify.prisma.pC.findUnique({ where: { id: params.id } });
    if (!pc) {
      return reply.status(404).send({ error: 'PC nao encontrado' });
    }
    if (pc.hostId !== user.host.id) {
      return reply.status(403).send({ error: 'Sem permissao' });
    }

    const data = { ...body };
    if (body.connectionPort === undefined) {
      delete data.connectionPort;
    }

    return fastify.prisma.pC.update({
      where: { id: params.id },
      data,
    });
  });

  fastify.delete('/pcs/:id', async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const user = await requireUser(request, reply, fastify.prisma);
    if (!user) return;
    if (!user.host) {
      return reply.status(403).send({ error: 'Usuario nao e host' });
    }

    const pc = await fastify.prisma.pC.findUnique({ where: { id: params.id } });
    if (!pc) {
      return reply.status(404).send({ error: 'PC nao encontrado' });
    }
    if (pc.hostId !== user.host.id) {
      return reply.status(403).send({ error: 'Sem permissao' });
    }

    await fastify.prisma.pC.delete({ where: { id: params.id } });
    return { ok: true };
  });

  fastify.patch('/pcs/:id/status', async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const schema = z.object({
      status: z.enum(['ONLINE', 'OFFLINE']),
    });
    const body = schema.parse(request.body);

    const user = await requireUser(request, reply, fastify.prisma);
    if (!user) return;
    if (!user.host) {
      return reply.status(403).send({ error: 'Usuario nao e host' });
    }

    const pc = await fastify.prisma.pC.findUnique({ where: { id: params.id } });
    if (!pc) {
      return reply.status(404).send({ error: 'PC nao encontrado' });
    }
    if (pc.hostId !== user.host.id) {
      return reply.status(403).send({ error: 'Sem permissao' });
    }
    if (pc.status === PCStatus.BUSY && body.status === 'OFFLINE') {
      return reply.status(409).send({ error: 'PC ocupado' });
    }

    const updated = await fastify.prisma.pC.update({
      where: { id: params.id },
      data: { status: body.status },
    });

    await fastify.prisma.hostProfile.update({
      where: { id: pc.hostId },
      data: { lastSeenAt: new Date() },
    });

    return reply.send({ pc: updated });
  });
}
