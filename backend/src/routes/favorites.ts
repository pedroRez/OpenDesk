import { z } from 'zod';
import { PCStatus, QueueEntryStatus, SessionStatus } from '@prisma/client';

import type { FastifyInstance } from 'fastify';

import { requireUser } from '../utils/auth.js';

const favoriteTargetSchema = z.object({
  pcId: z.string().optional(),
  hostId: z.string().optional(),
});

export async function favoriteRoutes(fastify: FastifyInstance) {
  fastify.get('/favorites', async (request, reply) => {
    const user = await requireUser(request, reply, fastify.prisma);
    if (!user) return;

    const favorites = await fastify.prisma.favorite.findMany({
      where: { userId: user.id },
      include: {
        pc: {
          select: {
            id: true,
            name: true,
            status: true,
            sessions: {
              where: { status: { in: [SessionStatus.ACTIVE, SessionStatus.PENDING] } },
              select: { id: true },
            },
          },
        },
        host: {
          select: {
            id: true,
            displayName: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    const pcIds = favorites.flatMap((favorite) => (favorite.pcId ? [favorite.pcId] : []));
    const queueCounts =
      pcIds.length > 0
        ? await fastify.prisma.queueEntry.groupBy({
            by: ['pcId'],
            where: { pcId: { in: pcIds }, status: QueueEntryStatus.WAITING },
            _count: { _all: true },
          })
        : [];
    const queueCountMap = new Map(queueCounts.map((item) => [item.pcId, item._count._all]));

    return favorites.map((favorite) => {
      const pc = favorite.pc
        ? {
            id: favorite.pc.id,
            name: favorite.pc.name,
            status: favorite.pc.sessions.length > 0 ? PCStatus.BUSY : favorite.pc.status,
            queueCount: queueCountMap.get(favorite.pc.id) ?? 0,
          }
        : null;

      const host = favorite.host
        ? {
            id: favorite.host.id,
            displayName: favorite.host.displayName,
          }
        : null;

      return {
        id: favorite.id,
        pcId: favorite.pcId,
        hostId: favorite.hostId,
        createdAt: favorite.createdAt,
        pc,
        host,
      };
    });
  });

  fastify.post('/favorites', async (request, reply) => {
    const body = favoriteTargetSchema.parse(request.body ?? {});
    const user = await requireUser(request, reply, fastify.prisma);
    if (!user) return;

    const hasPc = Boolean(body.pcId);
    const hasHost = Boolean(body.hostId);
    if (hasPc === hasHost) {
      return reply.status(400).send({ error: 'Informe pcId ou hostId' });
    }

    if (body.pcId) {
      const pc = await fastify.prisma.pC.findUnique({ where: { id: body.pcId }, select: { id: true } });
      if (!pc) {
        return reply.status(404).send({ error: 'PC nao encontrado' });
      }

      const existing = await fastify.prisma.favorite.findFirst({
        where: { userId: user.id, pcId: body.pcId },
      });
      if (existing) {
        return reply.status(409).send({ error: 'Favorito ja existe' });
      }

      const favorite = await fastify.prisma.favorite.create({
        data: {
          userId: user.id,
          pcId: body.pcId,
        },
      });

      return reply.status(201).send({ favorite });
    }

    const host = await fastify.prisma.hostProfile.findUnique({
      where: { id: body.hostId },
      select: { id: true },
    });
    if (!host) {
      return reply.status(404).send({ error: 'Host nao encontrado' });
    }

    const existing = await fastify.prisma.favorite.findFirst({
      where: { userId: user.id, hostId: body.hostId },
    });
    if (existing) {
      return reply.status(409).send({ error: 'Favorito ja existe' });
    }

    const favorite = await fastify.prisma.favorite.create({
      data: {
        userId: user.id,
        hostId: body.hostId,
      },
    });

    return reply.status(201).send({ favorite });
  });

  fastify.delete('/favorites', async (request, reply) => {
    const body = favoriteTargetSchema.parse(request.body ?? {});
    const user = await requireUser(request, reply, fastify.prisma);
    if (!user) return;

    const hasPc = Boolean(body.pcId);
    const hasHost = Boolean(body.hostId);
    if (hasPc === hasHost) {
      return reply.status(400).send({ error: 'Informe pcId ou hostId' });
    }

    const existing = await fastify.prisma.favorite.findFirst({
      where: {
        userId: user.id,
        pcId: body.pcId ?? undefined,
        hostId: body.hostId ?? undefined,
      },
    });

    if (!existing) {
      return reply.status(404).send({ error: 'Favorito nao encontrado' });
    }

    await fastify.prisma.favorite.delete({ where: { id: existing.id } });
    return reply.send({ ok: true });
  });
}
