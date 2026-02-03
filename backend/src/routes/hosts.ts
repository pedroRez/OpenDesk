import { z } from 'zod';

import { registerHeartbeat } from '../services/hostHeartbeat.js';
import { getReliabilityBadge, getReliabilityStats, getReliabilityStatsMap } from '../services/hostReliabilityStats.js';
import { requireUser } from '../utils/auth.js';

import type { FastifyInstance } from 'fastify';

export async function hostRoutes(fastify: FastifyInstance) {
  fastify.get('/hosts', async () => {
    const hosts = await fastify.prisma.hostProfile.findMany({
      include: { pcs: true, user: true },
    });

    const reliabilityMap = await getReliabilityStatsMap(
      fastify.prisma,
      hosts.map((host) => host.id),
    );

    return hosts.map((host) => {
      const reliability = reliabilityMap.get(host.id);
      const stats =
        reliability?.stats ?? {
          sessionsTotal: host.sessionsTotal ?? 0,
          sessionsCompleted: host.sessionsCompleted ?? 0,
          sessionsDropped: host.sessionsDropped ?? 0,
          onlineMinutes7d: 0,
          lastDropAt: host.lastDropAt ?? null,
        };
      const badge = reliability?.badge ?? getReliabilityBadge(stats);

      return {
        ...host,
        reliabilityStats: stats,
        reliabilityBadge: badge,
      };
    });
  });

  fastify.get('/host/pcs', async (request, reply) => {
    const user = await requireUser(request, reply, fastify.prisma);
    if (!user) return;
    if (!user.host) {
      return reply.status(403).send({ error: 'Usuario nao e host' });
    }

    const pcs = await fastify.prisma.pC.findMany({
      where: { hostId: user.host.id },
    });

    const badge = getReliabilityBadge({
      sessionsTotal: user.host?.sessionsTotal ?? 0,
      sessionsCompleted: user.host?.sessionsCompleted ?? 0,
    });

    return pcs.map((pc) => ({
      ...pc,
      reliabilityBadge: badge,
    }));
  });

  fastify.post('/host/profile', async (request, reply) => {
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

    const reliability = await getReliabilityStats(fastify.prisma, hostProfile.id);

    return reply.send({
      hostProfile: {
        ...hostProfile,
        reliabilityStats: reliability?.stats ?? {
          sessionsTotal: hostProfile.sessionsTotal ?? 0,
          sessionsCompleted: hostProfile.sessionsCompleted ?? 0,
          sessionsDropped: hostProfile.sessionsDropped ?? 0,
          onlineMinutes7d: 0,
          lastDropAt: hostProfile.lastDropAt ?? null,
        },
        reliabilityBadge:
          reliability?.badge ??
          getReliabilityBadge({
            sessionsTotal: hostProfile.sessionsTotal ?? 0,
            sessionsCompleted: hostProfile.sessionsCompleted ?? 0,
          }),
      },
      hostProfileId: hostProfile.id,
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

    const reliability = await getReliabilityStats(fastify.prisma, hostProfile.id);

    return reply.send({
      hostProfile: {
        ...hostProfile,
        reliabilityStats: reliability?.stats ?? {
          sessionsTotal: hostProfile.sessionsTotal ?? 0,
          sessionsCompleted: hostProfile.sessionsCompleted ?? 0,
          sessionsDropped: hostProfile.sessionsDropped ?? 0,
          onlineMinutes7d: 0,
          lastDropAt: hostProfile.lastDropAt ?? null,
        },
        reliabilityBadge:
          reliability?.badge ??
          getReliabilityBadge({
            sessionsTotal: hostProfile.sessionsTotal ?? 0,
            sessionsCompleted: hostProfile.sessionsCompleted ?? 0,
          }),
      },
      hostProfileId: hostProfile.id,
    });
  });

  fastify.post('/hosts/:id/heartbeat', async (request, reply) => {
    const paramsSchema = z.object({ id: z.string() });
    const params = paramsSchema.parse(request.params);

    const bodySchema = z.object({
      status: z.enum(['ONLINE', 'OFFLINE', 'BUSY']).optional(),
      pcId: z.string().nullable().optional(),
      timestamp: z.string().optional(),
    });
    const body = bodySchema.parse(request.body ?? {});
    const logTimestamp = body.timestamp ?? new Date().toISOString();
    console.log('[HB][BACKEND] recebido', {
      hostId: params.id,
      pcId: body.pcId ?? null,
      timestamp: logTimestamp,
    });
    const user = await requireUser(request, reply, fastify.prisma);
    if (!user) {
      console.error('[HB][BACKEND] 401', {
        hostId: params.id,
        pcId: body.pcId ?? null,
        timestamp: logTimestamp,
      });
      return;
    }
    if (!user.host || user.host.id !== params.id) {
      console.error('[HB][BACKEND] 403', {
        hostId: params.id,
        userId: user?.id ?? null,
        pcId: body.pcId ?? null,
        timestamp: logTimestamp,
      });
      return reply.status(403).send({ error: 'Sem permissao' });
    }

    try {
      await registerHeartbeat({
        prisma: fastify.prisma,
        hostId: params.id,
        status: body.status,
      });
      console.log('[HB][BACKEND] atualizado', {
        hostId: params.id,
        pcId: body.pcId ?? null,
        timestamp: logTimestamp,
      });
    } catch (error) {
      console.error('[HB][BACKEND] erro ao atualizar', {
        hostId: params.id,
        pcId: body.pcId ?? null,
        timestamp: logTimestamp,
        error: error instanceof Error ? error.message : error,
      });
      throw error;
    }

    return { ok: true };
  });
}
