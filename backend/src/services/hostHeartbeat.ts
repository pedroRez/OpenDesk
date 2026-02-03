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
    const before = await prisma.hostProfile.findUnique({
      where: { id: hostId },
      select: { lastSeenAt: true },
    });
    console.log('[HEARTBEAT][BACKEND] lastSeen before', {
      hostId,
      lastSeenAt: before?.lastSeenAt?.toISOString() ?? null,
    });

    await prisma.hostProfile.update({
      where: { id: hostId },
      data: { lastSeenAt: new Date() },
    });

    const after = await prisma.hostProfile.findUnique({
      where: { id: hostId },
      select: { lastSeenAt: true },
    });
    console.log('[HEARTBEAT][BACKEND] lastSeen after', {
      hostId,
      lastSeenAt: after?.lastSeenAt?.toISOString() ?? null,
    });
  } catch (error) {
    console.error('[HEARTBEAT][BACKEND] erro ao atualizar lastSeen', {
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
  const cutoff = new Date(Date.now() - config.hostHeartbeatTimeoutMs);

  const hosts = await prisma.hostProfile.findMany({
    where: {
      lastSeenAt: { lt: cutoff },
      pcs: { some: { status: { not: PCStatus.OFFLINE } } },
    },
    select: { id: true },
  });

  await Promise.all(
    hosts.map(async (host) => {
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
