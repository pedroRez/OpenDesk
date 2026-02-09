import { PCStatus, SessionStatus, type PrismaClient } from '@prisma/client';

import { config } from '../config.js';
import { clearQueueForPc, endSession } from './sessionService.js';
import { recordReliabilityEvent } from './hostReliability.js';
import { recordHostDrop, recordHostOnlineMinute } from './hostReliabilityStats.js';

const offlineSinceByHost = new Map<string, number>();

export async function registerHeartbeat(params: {
  prisma: PrismaClient;
  hostId: string;
  status?: PCStatus;
}): Promise<void> {
  const { prisma, hostId, status } = params;

  try {
    const now = new Date();
    await prisma.hostProfile.update({
      where: { id: hostId },
      data: { lastSeenAt: now },
    });
    offlineSinceByHost.delete(hostId);

    if (status !== PCStatus.OFFLINE) {
      await recordHostOnlineMinute(prisma, hostId, now);
    }

    logHeartbeatSample(hostId, now);
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

const lastHeartbeatLogByHost = new Map<string, number>();

function logHeartbeatSample(hostId: string, timestamp: Date): void {
  const level = (config.logHeartbeat ?? 'sampled').toLowerCase();
  const isDebug = level === 'debug' || level === 'full' || level === 'true';
  if (level === 'off' || level === 'false') return;

  if (isDebug) {
    console.log('[HB][BACKEND] alive', { hostId, timestamp: timestamp.toISOString() });
    return;
  }

  const nowMs = timestamp.getTime();
  const last = lastHeartbeatLogByHost.get(hostId) ?? 0;
  const intervalMs = Math.max(1, config.heartbeatLogSampleSeconds) * 1000;
  if (nowMs - last >= intervalMs) {
    lastHeartbeatLogByHost.set(hostId, nowMs);
    console.log('[HB][BACKEND] alive', { hostId, timestamp: timestamp.toISOString() });
  }
}

export async function handleHostTimeouts(prisma: PrismaClient): Promise<number> {
  const now = new Date();
  const thresholdMs = config.hostHeartbeatTimeoutMs;
  const cutoff = new Date(now.getTime() - thresholdMs);
  const graceMs = Math.max(0, config.hostOfflineGraceSeconds) * 1000;

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

      const offlineSince = offlineSinceByHost.get(host.id);
      if (!offlineSince) {
        offlineSinceByHost.set(host.id, now.getTime());
        return;
      }
      const offlineDuration = now.getTime() - offlineSince;
      if (offlineDuration < graceMs) {
        return;
      }

      await recordReliabilityEvent(prisma, host.id, 'HOST_DOWN');
      await recordHostDrop(prisma, host.id, now);

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

      await Promise.all(
        host.pcs.map((pc) => clearQueueForPc(prisma, pc.id)),
      );

      offlineSinceByHost.delete(host.id);
    }),
  );

  return hosts.length;
}
