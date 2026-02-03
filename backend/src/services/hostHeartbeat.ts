import { PCStatus, SessionStatus, type PrismaClient } from '@prisma/client';

import { config } from '../config.js';
import { endSession } from './sessionService.js';
import { recordReliabilityEvent } from './hostReliability.js';

export async function registerHeartbeat(params: {
  prisma: PrismaClient;
  hostId: string;
  status?: PCStatus;
}): Promise<void> {
  const { prisma, hostId, status } = params;

  try {
    const now = new Date();
    const before = await prisma.hostProfile.findUnique({
      where: { id: hostId },
      select: { lastSeenAt: true },
    });
    console.log('[HB][BACKEND] lastSeen before', {
      hostId,
      lastSeenAt: before?.lastSeenAt?.toISOString() ?? null,
      now: now.toISOString(),
    });

    const updated = await prisma.hostProfile.update({
      where: { id: hostId },
      data: { lastSeenAt: now },
      select: { lastSeenAt: true },
    });

    console.log('[HB][BACKEND] lastSeen after', {
      hostId,
      lastSeenAt: updated.lastSeenAt?.toISOString() ?? null,
      now: now.toISOString(),
    });
  } catch (error) {
    console.error('[HB][BACKEND] erro ao atualizar lastSeen', {
      hostId,
      error: error instanceof Error ? error.message : error,
    });
    throw error;
  }

  if (status) {
    await prisma.pC.updateMany({
      where: { hostId },
      data: { status },
    });
  }
}

export async function handleHostTimeouts(prisma: PrismaClient): Promise<number> {
  const now = new Date();
  const thresholdMs = config.hostHeartbeatTimeoutMs;
  const cutoff = new Date(now.getTime() - thresholdMs);

  const hosts = await prisma.hostProfile.findMany({
    where: {
      lastSeenAt: { lt: cutoff },
      pcs: { some: { status: { not: PCStatus.OFFLINE } } },
    },
    select: {
      id: true,
      lastSeenAt: true,
      pcs: {
        where: { status: { not: PCStatus.OFFLINE } },
        select: { id: true, status: true },
      },
    },
  });

  await Promise.all(
    hosts.map(async (host) => {
      const diffMs = host.lastSeenAt ? now.getTime() - host.lastSeenAt.getTime() : null;
      console.warn('[HB][BACKEND] timeout derrubando host', {
        hostId: host.id,
        pcIds: host.pcs.map((pc) => pc.id),
        lastSeenAt: host.lastSeenAt?.toISOString() ?? null,
        now: now.toISOString(),
        diffMs,
        thresholdMs,
      });

      await prisma.pC.updateMany({
        where: { hostId: host.id },
        data: { status: PCStatus.OFFLINE },
      });

      await recordReliabilityEvent(prisma, host.id, 'HOST_DOWN');

      const sessions = await prisma.session.findMany({
        where: {
          status: SessionStatus.ACTIVE,
          pc: { hostId: host.id },
        },
        select: { id: true },
      });

      await Promise.all(
        sessions.map((session) =>
          endSession({
            prisma,
            sessionId: session.id,
            failureReason: 'HOST',
            releaseStatus: PCStatus.OFFLINE,
          }),
        ),
      );
    }),
  );

  return hosts.length;
}
