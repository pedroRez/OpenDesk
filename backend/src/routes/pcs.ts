import { z } from 'zod';
import { PCStatus, QueueEntryStatus, ReservationStatus, SessionStatus } from '@prisma/client';

import type { FastifyInstance } from 'fastify';

import { createAndStartSession, SessionError } from '../services/sessionService.js';
import { getReliabilityBadge } from '../services/hostReliabilityStats.js';
import { requireUser } from '../utils/auth.js';

const DEFAULT_MINUTES_PURCHASED = 60;
const PC_CATEGORY_ENUM = ['GAMES', 'DESIGN', 'VIDEO', 'DEV', 'OFFICE'] as const;
const pcCategorySchema = z.enum(PC_CATEGORY_ENUM);
const specSummarySchema = z.object({
  cpu: z.string().min(1),
  gpu: z.string().min(1),
  ram: z.string().min(1),
});
const categoriesQuerySchema = z.preprocess((value) => {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    const parsed = value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
    return parsed.length > 0 ? parsed : undefined;
  }
  return value;
}, z.array(pcCategorySchema)).optional();

export async function pcRoutes(fastify: FastifyInstance) {
  fastify.get('/pcs', async (request) => {
    const query = z
      .object({
        status: z.enum(['ONLINE', 'OFFLINE', 'BUSY']).optional(),
        categories: categoriesQuerySchema,
      })
      .parse(request.query ?? {});

    const where = query.categories?.length
      ? { categories: { hasSome: query.categories } }
      : undefined;

    const pcs = await fastify.prisma.pC.findMany({
      where,
      include: {
        softwareLinks: { include: { software: true } },
        host: true,
        sessions: {
          where: { status: { in: [SessionStatus.ACTIVE, SessionStatus.PENDING] } },
          select: { id: true },
        },
      },
    });

    const queueCounts =
      pcs.length > 0
        ? await fastify.prisma.queueEntry.groupBy({
            by: ['pcId'],
            where: {
              pcId: { in: pcs.map((pc) => pc.id) },
              status: QueueEntryStatus.WAITING,
            },
            _count: { _all: true },
          })
        : [];

    const queueCountMap = new Map(queueCounts.map((item) => [item.pcId, item._count._all]));

    const enriched = pcs.map(({ sessions, host, ...pc }) => ({
      ...pc,
      host,
      status: sessions.length > 0 ? PCStatus.BUSY : pc.status,
      queueCount: queueCountMap.get(pc.id) ?? 0,
      reliabilityBadge: host
        ? getReliabilityBadge({
            sessionsTotal: host.sessionsTotal ?? 0,
            sessionsCompleted: host.sessionsCompleted ?? 0,
          })
        : 'NOVO',
    }));

    if (query.status) {
      return enriched.filter((pc) => pc.status === query.status);
    }

    return enriched;
  });

  fastify.get('/pcs/:id', async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const pc = await fastify.prisma.pC.findUnique({
      where: { id: params.id },
      include: {
        softwareLinks: { include: { software: true } },
        host: true,
        sessions: {
          where: { status: { in: [SessionStatus.ACTIVE, SessionStatus.PENDING] } },
          select: { id: true },
        },
      },
    });

    if (!pc) {
      return reply.status(404).send({ error: 'PC não encontrado' });
    }

    const queueCount = await fastify.prisma.queueEntry.count({
      where: { pcId: pc.id, status: QueueEntryStatus.WAITING },
    });

    const { sessions, host, ...rest } = pc;
    return {
      ...rest,
      host,
      status: sessions.length > 0 ? PCStatus.BUSY : pc.status,
      queueCount,
      reliabilityBadge: host
        ? getReliabilityBadge({
            sessionsTotal: host.sessionsTotal ?? 0,
            sessionsCompleted: host.sessionsCompleted ?? 0,
          })
        : 'NOVO',
    };
  });

  fastify.post('/pcs', async (request, reply) => {
    const schema = z.object({
      hostId: z.string().optional(),
      name: z.string(),
      level: z.enum(['A', 'B', 'C']),
      categories: z.array(pcCategorySchema).optional(),
      softwareTags: z.array(z.string().min(1)).optional(),
      specSummary: specSummarySchema.optional(),
      description: z.string().max(280).optional(),
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

    const {
      hostId: _hostId,
      categories,
      softwareTags,
      specSummary,
      description,
      connectionPort,
      ...payload
    } = body;
    const resolvedSpecSummary =
      specSummary ??
      ({
        cpu: payload.cpu,
        gpu: payload.gpu,
        ram: `${payload.ramGb} GB`,
      } satisfies z.infer<typeof specSummarySchema>);

    return fastify.prisma.pC.create({
      data: {
        ...payload,
        hostId: user.host.id,
        connectionPort: connectionPort ?? 47990,
        categories: categories ?? [],
        softwareTags: softwareTags ?? [],
        description: description ?? '',
        specSummary: resolvedSpecSummary,
      },
    });
  });

  fastify.put('/pcs/:id', async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const schema = z.object({
      name: z.string().optional(),
      level: z.enum(['A', 'B', 'C']).optional(),
      categories: z.array(pcCategorySchema).optional(),
      softwareTags: z.array(z.string().min(1)).optional(),
      specSummary: specSummarySchema.optional(),
      description: z.string().max(280).optional(),
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
    const shouldSyncSpecSummary =
      body.specSummary ??
      (body.cpu || body.gpu || body.ramGb
        ? {
            cpu: body.cpu ?? pc.cpu,
            gpu: body.gpu ?? pc.gpu,
            ram: `${body.ramGb ?? pc.ramGb} GB`,
          }
        : undefined);

    if (shouldSyncSpecSummary) {
      data.specSummary = shouldSyncSpecSummary;
    }
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

  fastify.post('/pcs/:pcId/queue/join', async (request, reply) => {
    const params = z.object({ pcId: z.string() }).parse(request.params);
    const body = z
      .object({
        minutesPurchased: z.number().int().min(1).max(240).optional(),
      })
      .parse(request.body ?? {});
    const user = await requireUser(request, reply, fastify.prisma);
    if (!user) return;

    const header = request.headers['x-dev-bypass-credits'];
    const headerValue = Array.isArray(header) ? header[0] : header;
    const allowDevBypass = process.env.NODE_ENV !== 'production' && headerValue === 'true';
    const minutesPurchased = body.minutesPurchased ?? DEFAULT_MINUTES_PURCHASED;

    try {
      const payload = await fastify.prisma.$transaction(async (tx) => {
        const pc = await tx.pC.findUnique({
          where: { id: params.pcId },
          select: { id: true, status: true },
        });
        if (!pc) {
          throw new SessionError('PC nao encontrado', 'PC_NOT_FOUND', 404);
        }
        if (pc.status === PCStatus.OFFLINE) {
          throw new SessionError('PC offline', 'PC_OFFLINE', 409);
        }

        const existingEntry = await tx.queueEntry.findFirst({
          where: {
            pcId: params.pcId,
            userId: user.id,
            status: { in: [QueueEntryStatus.WAITING, QueueEntryStatus.ACTIVE] },
          },
          orderBy: { createdAt: 'asc' },
        });

        if (existingEntry) {
          const queueCount = await tx.queueEntry.count({
            where: { pcId: params.pcId, status: QueueEntryStatus.WAITING },
          });
          if (existingEntry.status === QueueEntryStatus.WAITING) {
            const position = await tx.queueEntry.count({
              where: {
                pcId: params.pcId,
                status: QueueEntryStatus.WAITING,
                createdAt: { lte: existingEntry.createdAt },
              },
            });
            return { status: 'WAITING', position, queueCount };
          }

          const activeSession = await tx.session.findFirst({
            where: {
              pcId: params.pcId,
              clientUserId: user.id,
              status: { in: [SessionStatus.PENDING, SessionStatus.ACTIVE] },
            },
            select: { id: true },
          });
          return { status: 'ACTIVE', sessionId: activeSession?.id ?? null, queueCount };
        }

        const existingClientSession = await tx.session.findFirst({
          where: {
            clientUserId: user.id,
            status: { in: [SessionStatus.PENDING, SessionStatus.ACTIVE] },
          },
          select: { id: true },
        });
        if (existingClientSession) {
          throw new SessionError('Usuario ja possui uma sessao ativa', 'SESSION_EXISTS', 409);
        }

        const activeSession = await tx.session.findFirst({
          where: {
            pcId: params.pcId,
            status: { in: [SessionStatus.PENDING, SessionStatus.ACTIVE] },
          },
          select: { id: true },
        });
        const isBusy = Boolean(activeSession) || pc.status === PCStatus.BUSY;

        if (!isBusy && pc.status === PCStatus.ONLINE) {
          const session = await createAndStartSession({
            prisma: tx,
            pcId: params.pcId,
            clientId: user.id,
            minutesPurchased,
            bypassCredits: allowDevBypass,
          });

          await tx.queueEntry.create({
            data: {
              pcId: params.pcId,
              userId: user.id,
              minutesPurchased,
              status: QueueEntryStatus.ACTIVE,
            },
          });

          const queueCount = await tx.queueEntry.count({
            where: { pcId: params.pcId, status: QueueEntryStatus.WAITING },
          });
          return { status: 'ACTIVE', sessionId: session.id, queueCount };
        }

        const entry = await tx.queueEntry.create({
          data: {
            pcId: params.pcId,
            userId: user.id,
            minutesPurchased,
            status: QueueEntryStatus.WAITING,
          },
        });

        const queueCount = await tx.queueEntry.count({
          where: { pcId: params.pcId, status: QueueEntryStatus.WAITING },
        });

        const position = await tx.queueEntry.count({
          where: {
            pcId: params.pcId,
            status: QueueEntryStatus.WAITING,
            createdAt: { lte: entry.createdAt },
          },
        });

        return { status: 'WAITING', position, queueCount };
      });

      return reply.send(payload);
    } catch (error) {
      if (error instanceof SessionError) {
        return reply.status(error.status).send({ error: error.message, code: error.code });
      }
      const message = error instanceof Error ? error.message : 'Erro ao entrar na fila';
      return reply.status(400).send({ error: message });
    }
  });

  fastify.post('/pcs/:pcId/queue/leave', async (request, reply) => {
    const params = z.object({ pcId: z.string() }).parse(request.params);
    const user = await requireUser(request, reply, fastify.prisma);
    if (!user) return;

    const entry = await fastify.prisma.queueEntry.findFirst({
      where: {
        pcId: params.pcId,
        userId: user.id,
        status: QueueEntryStatus.WAITING,
      },
    });

    if (!entry) {
      return reply.status(404).send({ error: 'Entrada na fila nao encontrada' });
    }

    await fastify.prisma.queueEntry.update({
      where: { id: entry.id },
      data: { status: QueueEntryStatus.CANCELLED },
    });

    return { ok: true };
  });

  fastify.get('/pcs/:pcId/queue', async (request, reply) => {
    const params = z.object({ pcId: z.string() }).parse(request.params);
    const header = request.headers['x-user-id'];
    const hasUserHeader = Boolean(header);
    const user = hasUserHeader ? await requireUser(request, reply, fastify.prisma) : null;
    if (hasUserHeader && !user) return;

    const queueCount = await fastify.prisma.queueEntry.count({
      where: { pcId: params.pcId, status: QueueEntryStatus.WAITING },
    });

    let position: number | null = null;
    let status: QueueEntryStatus | null = null;
    let sessionId: string | null = null;

    if (user) {
      const entry = await fastify.prisma.queueEntry.findFirst({
        where: {
          pcId: params.pcId,
          userId: user.id,
          status: { in: [QueueEntryStatus.WAITING, QueueEntryStatus.ACTIVE] },
        },
        orderBy: { createdAt: 'asc' },
      });

      if (entry) {
        status = entry.status;
        if (entry.status === QueueEntryStatus.WAITING) {
          position = await fastify.prisma.queueEntry.count({
            where: {
              pcId: params.pcId,
              status: QueueEntryStatus.WAITING,
              createdAt: { lte: entry.createdAt },
            },
          });
        } else {
          const activeSession = await fastify.prisma.session.findFirst({
            where: {
              pcId: params.pcId,
              clientUserId: user.id,
              status: { in: [SessionStatus.PENDING, SessionStatus.ACTIVE] },
            },
            select: { id: true },
          });
          sessionId = activeSession?.id ?? null;
        }
      }
    }

    return { queueCount, position, status, sessionId };
  });

  fastify.get('/my/queue/updates', async (request, reply) => {
    const user = await requireUser(request, reply, fastify.prisma);
    if (!user) return;

    const entries = await fastify.prisma.queueEntry.findMany({
      where: {
        userId: user.id,
        status: { in: [QueueEntryStatus.WAITING, QueueEntryStatus.ACTIVE] },
      },
      orderBy: { createdAt: 'asc' },
    });

    const pcIds = entries.map((entry) => entry.pcId);
    const queueCounts =
      pcIds.length > 0
        ? await fastify.prisma.queueEntry.groupBy({
            by: ['pcId'],
            where: { pcId: { in: pcIds }, status: QueueEntryStatus.WAITING },
            _count: { _all: true },
          })
        : [];

    const queueCountMap = new Map(queueCounts.map((item) => [item.pcId, item._count._all]));

    const payload = await Promise.all(
      entries.map(async (entry) => {
        const queueCount = queueCountMap.get(entry.pcId) ?? 0;
        let position: number | null = null;
        if (entry.status === QueueEntryStatus.WAITING) {
          position = await fastify.prisma.queueEntry.count({
            where: {
              pcId: entry.pcId,
              status: QueueEntryStatus.WAITING,
              createdAt: { lte: entry.createdAt },
            },
          });
        }
        const session = await fastify.prisma.session.findFirst({
          where: {
            pcId: entry.pcId,
            clientUserId: user.id,
            status: { in: [SessionStatus.PENDING, SessionStatus.ACTIVE] },
          },
          select: { id: true },
        });

        return {
          pcId: entry.pcId,
          status: entry.status,
          position,
          queueCount,
          sessionId: session?.id ?? null,
        };
      }),
    );

    return { entries: payload };
  });

  fastify.post('/pcs/:pcId/reservations', async (request, reply) => {
    const params = z.object({ pcId: z.string() }).parse(request.params);
    const body = z
      .object({
        startAt: z.string(),
        durationMin: z.number().int().min(15).max(480).optional(),
        endAt: z.string().optional(),
      })
      .parse(request.body ?? {});

    const user = await requireUser(request, reply, fastify.prisma);
    if (!user) return;

    const startAt = new Date(body.startAt);
    const endAt = body.endAt
      ? new Date(body.endAt)
      : body.durationMin
        ? new Date(startAt.getTime() + body.durationMin * 60000)
        : null;

    if (Number.isNaN(startAt.getTime()) || !endAt || Number.isNaN(endAt.getTime())) {
      return reply.status(400).send({ error: 'Horario invalido' });
    }

    if (endAt <= startAt) {
      return reply.status(400).send({ error: 'Horario invalido' });
    }

    if (startAt.getTime() < Date.now()) {
      return reply.status(400).send({ error: 'Nao e possivel agendar no passado' });
    }

    const pc = await fastify.prisma.pC.findUnique({
      where: { id: params.pcId },
      select: { status: true },
    });
    if (!pc) {
      return reply.status(404).send({ error: 'PC nao encontrado' });
    }
    if (pc.status === PCStatus.OFFLINE) {
      return reply.status(409).send({ error: 'PC offline' });
    }

    const conflict = await fastify.prisma.reservation.findFirst({
      where: {
        pcId: params.pcId,
        status: { in: [ReservationStatus.SCHEDULED, ReservationStatus.ACTIVE] },
        startAt: { lt: endAt },
        endAt: { gt: startAt },
      },
    });

    if (conflict) {
      return reply.status(409).send({ error: 'Horario indisponivel' });
    }

    const reservation = await fastify.prisma.reservation.create({
      data: {
        pcId: params.pcId,
        userId: user.id,
        startAt,
        endAt,
        status: ReservationStatus.SCHEDULED,
      },
    });

    return reply.status(201).send({ reservation });
  });

  fastify.get('/pcs/:pcId/reservations/availability', async (request, reply) => {
    const params = z.object({ pcId: z.string() }).parse(request.params);
    const query = z
      .object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      })
      .parse(request.query ?? {});

    const startOfDay = new Date(`${query.date}T00:00:00`);
    const endOfDay = new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000);

    const reservations = await fastify.prisma.reservation.findMany({
      where: {
        pcId: params.pcId,
        status: { in: [ReservationStatus.SCHEDULED, ReservationStatus.ACTIVE] },
        startAt: { lt: endOfDay },
        endAt: { gt: startOfDay },
      },
      orderBy: { startAt: 'asc' },
    });

    return reply.send({ date: query.date, reservations });
  });

  fastify.get('/my/reservations', async (request, reply) => {
    const user = await requireUser(request, reply, fastify.prisma);
    if (!user) return;

    const reservations = await fastify.prisma.reservation.findMany({
      where: { userId: user.id },
      include: { pc: true },
      orderBy: { startAt: 'asc' },
    });

    return reply.send({ reservations });
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
