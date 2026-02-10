import { z } from 'zod';

import { config } from '../config.js';
import { registerHeartbeat } from '../services/hostHeartbeat.js';
import { endSession } from '../services/sessionService.js';
import { getReliabilityBadge, getReliabilityStats, getReliabilityStatsMap } from '../services/hostReliabilityStats.js';
import { sanitizeHost } from '../utils/hostPublic.js';
import { requireUser } from '../utils/auth.js';
import { PCStatus, QueueEntryStatus, SessionStatus } from '@prisma/client';

import type { FastifyInstance } from 'fastify';

export async function hostRoutes(fastify: FastifyInstance) {
  const listHostPcs = async (hostId: string) => {
    const pcs = await fastify.prisma.pC.findMany({
      where: { hostId },
    });
    const pcIds = pcs.map((pc) => pc.id);
    const queueCounts = pcIds.length
      ? await fastify.prisma.queueEntry.groupBy({
          by: ['pcId'],
          where: {
            pcId: { in: pcIds },
            status: { in: [QueueEntryStatus.WAITING, QueueEntryStatus.PROMOTED] },
          },
          _count: { _all: true },
        })
      : [];
    const queueCountMap = new Map(queueCounts.map((item) => [item.pcId, item._count._all]));

    const activeSessions = pcIds.length
      ? await fastify.prisma.session.findMany({
          where: { pcId: { in: pcIds }, status: SessionStatus.ACTIVE },
          select: {
            id: true,
            pcId: true,
            startAt: true,
            clientIp: true,
            client: { select: { username: true } },
          },
        })
      : [];
    const activeSessionMap = new Map(activeSessions.map((session) => [session.pcId, session]));

    const host = await fastify.prisma.hostProfile.findUnique({
      where: { id: hostId },
      select: { sessionsTotal: true, sessionsCompleted: true },
    });

    const badge = getReliabilityBadge({
      sessionsTotal: host?.sessionsTotal ?? 0,
      sessionsCompleted: host?.sessionsCompleted ?? 0,
    });

    return pcs.map((pc) => ({
      ...pc,
      queueCount: queueCountMap.get(pc.id) ?? 0,
      activeSession: activeSessionMap.get(pc.id) ?? null,
      reliabilityBadge: badge,
    }));
  };

  fastify.get('/hosts', async () => {
    const hosts = await fastify.prisma.hostProfile.findMany({
      include: { pcs: true, user: { select: { username: true } } },
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

      const safeHost = sanitizeHost(host);
      return {
        ...safeHost,
        reliabilityStats: stats,
        reliabilityBadge: badge,
      };
    });
  });

  fastify.get('/host/pcs', async (request, reply) => {
    const user = await requireUser(request, reply, fastify.prisma);
    if (!user) return;
    if (!user.username) {
      return reply.status(400).send({ error: 'Defina um username antes de virar host' });
    }
    if (!user.host) {
      return reply.status(403).send({ error: 'Usuario nao e host' });
    }

    return listHostPcs(user.host.id);
  });

  fastify.get('/hosts/:id/pcs', async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const user = await requireUser(request, reply, fastify.prisma);
    if (!user) return;
    if (!user.host) {
      return reply.status(403).send({ error: 'Usuario nao e host' });
    }
    if (user.host.id !== params.id) {
      return reply.status(403).send({ error: 'Sem permissao' });
    }

    return listHostPcs(params.id);
  });

  fastify.post('/host/profile', async (request, reply) => {
    const schema = z.object({
      displayName: z.string().optional(),
    });

    schema.parse(request.body);
    const user = await requireUser(request, reply, fastify.prisma);
    if (!user) return;

    const hostProfile = await fastify.prisma.hostProfile.upsert({
      where: { userId: user.id },
      update: { displayName: user.username },
      create: { userId: user.id, displayName: user.username },
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
      displayName: z.string().optional(),
    });

    schema.parse(request.body);
    const user = await requireUser(request, reply, fastify.prisma);
    if (!user) return;
    if (!user.username) {
      return reply.status(400).send({ error: 'Defina um username antes de virar host' });
    }

    const hostProfile = await fastify.prisma.hostProfile.upsert({
      where: { userId: user.id },
      update: { displayName: user.username },
      create: { userId: user.id, displayName: user.username },
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
    const logLevel = (config.logHeartbeat ?? 'sampled').toLowerCase();
    const isDebug = logLevel === 'debug' || logLevel === 'full' || logLevel === 'true';
    if (isDebug) {
      console.log('[HB][BACKEND] recebido', {
        hostId: params.id,
        pcId: body.pcId ?? null,
        timestamp: logTimestamp,
      });
    }
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
      if (isDebug) {
        console.log('[HB][BACKEND] atualizado', {
          hostId: params.id,
          pcId: body.pcId ?? null,
          timestamp: logTimestamp,
        });
      }
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

  fastify.post('/host/pcs/:pcId/disconnect', async (request, reply) => {
    const params = z.object({ pcId: z.string() }).parse(request.params);
    const user = await requireUser(request, reply, fastify.prisma);
    if (!user) return;
    if (!user.host) {
      return reply.status(403).send({ error: 'Usuario nao e host' });
    }

    const pc = await fastify.prisma.pC.findUnique({ where: { id: params.pcId } });
    if (!pc) {
      return reply.status(404).send({ error: 'PC nao encontrado' });
    }
    if (pc.hostId !== user.host.id) {
      return reply.status(403).send({ error: 'Sem permissao' });
    }

    const activeSession = await fastify.prisma.session.findFirst({
      where: {
        pcId: pc.id,
        status: { in: [SessionStatus.ACTIVE] },
      },
      select: { id: true },
    });

    if (activeSession) {
      await endSession({
        prisma: fastify.prisma,
        sessionId: activeSession.id,
        failureReason: 'HOST',
        hostFault: true,
        releaseStatus: PCStatus.ONLINE,
      });
    } else if (pc.status === PCStatus.BUSY) {
      await fastify.prisma.pC.update({
        where: { id: pc.id },
        data: { status: PCStatus.ONLINE },
      });
    }

    const updated = await fastify.prisma.pC.findUnique({ where: { id: pc.id } });
    return reply.send({ pc: updated, sessionEnded: Boolean(activeSession) });
  });
}

