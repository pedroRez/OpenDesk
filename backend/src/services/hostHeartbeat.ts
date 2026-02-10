import { PCStatus, SessionStatus, type PrismaClient } from '@prisma/client';

import { config } from '../config.js';
import { clearQueueForPc, endSession } from './sessionService.js';
import { recordReliabilityEvent } from './hostReliability.js';
import { recordHostDrop, recordHostOnlineMinute } from './hostReliabilityStats.js';

// Controle de transicao ONLINE -> UNSTABLE -> OFFLINE por host.
const offlineSinceByHost = new Map<string, number>();
// Intervalo informado pelo host para calcular jitter tolerance.
const lastIntervalByHost = new Map<string, number>();
const hostStateByHost = new Map<string, 'ONLINE' | 'UNSTABLE' | 'OFFLINE'>();

export async function registerHeartbeat(params: {
  prisma: PrismaClient;
  hostId: string;
  status?: PCStatus;
  intervalMs?: number | null;
  seq?: number | null;
  sentAt?: string | null;
}): Promise<void> {
  const { prisma, hostId, status, intervalMs, seq, sentAt } = params;

  try {
    const now = new Date();
    const previous = await prisma.hostProfile.findUnique({
      where: { id: hostId },
      select: { lastSeenAt: true },
    });
    await prisma.hostProfile.update({
      where: { id: hostId },
      data: { lastSeenAt: now },
    });
    console.log('[HB][BACKEND] lastSeenAt updated', {
      hostId,
      previousLastSeenAt: previous?.lastSeenAt?.toISOString() ?? null,
      newLastSeenAt: now.toISOString(),
    });
    const hadOffline = offlineSinceByHost.delete(hostId);
    hostStateByHost.set(hostId, 'ONLINE');
    if (intervalMs && Number.isFinite(intervalMs) && intervalMs > 0) {
      lastIntervalByHost.set(hostId, intervalMs);
    }
    if (seq || sentAt) {
      console.log('[HB][BACKEND] received', {
        hostId,
        receivedAt: now.toISOString(),
        seq: seq ?? null,
        sentAt: sentAt ?? null,
        intervalMs: intervalMs ?? null,
      });
    }
    if (hadOffline) {
      console.warn('[HB][BACKEND] host recovered', {
        hostId,
        timestamp: now.toISOString(),
      });
    }

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
  const baseThresholdMs = config.hostHeartbeatTimeoutMs;
  const cutoff = new Date(now.getTime() - baseThresholdMs);

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

  let offlineTransitions = 0;

  await Promise.all(
    hosts.map(async (host) => {
      const diffMs = host.lastSeenAt ? now.getTime() - host.lastSeenAt.getTime() : null;
      const activeSessions = await prisma.session.count({
        where: {
          status: SessionStatus.ACTIVE,
          pc: { hostId: host.id },
        },
      });
      const hasActiveSession = activeSessions > 0;
      const timeoutMs = hasActiveSession
        ? config.hostHeartbeatTimeoutActiveMs
        : config.hostHeartbeatTimeoutMs;
      const intervalMs = lastIntervalByHost.get(host.id) ?? config.hostHeartbeatCheckIntervalMs;
      // Jitter tolerance = 3x interval para evitar falso positivo por pequenos atrasos.
      const jitterToleranceMs = Math.max(0, intervalMs) * 3;
      const graceMs = Math.max(
        0,
        hasActiveSession ? config.hostOfflineGraceActiveSeconds : config.hostOfflineGraceSeconds,
      ) * 1000;

      if (diffMs !== null && diffMs < timeoutMs + jitterToleranceMs) {
        return;
      }

      const offlineSince = offlineSinceByHost.get(host.id);
      if (!offlineSince) {
        offlineSinceByHost.set(host.id, now.getTime());
        if (hostStateByHost.get(host.id) !== 'UNSTABLE') {
          hostStateByHost.set(host.id, 'UNSTABLE');
          console.warn('[HB][BACKEND] host unstable', {
            hostId: host.id,
            pcIds: host.pcs.map((pc) => pc.id),
            lastSeenAt: host.lastSeenAt?.toISOString() ?? null,
            now: now.toISOString(),
            diffMs,
            thresholdMs: timeoutMs,
            jitterToleranceMs,
            intervalMs,
            activeSessions,
          });
        }
        return;
      }
      const offlineDuration = now.getTime() - offlineSince;
      if (offlineDuration < graceMs) {
        return;
      }

      if (hostStateByHost.get(host.id) !== 'OFFLINE') {
        hostStateByHost.set(host.id, 'OFFLINE');
        console.warn('[HB][BACKEND] host offline', {
          hostId: host.id,
          pcIds: host.pcs.map((pc) => pc.id),
          lastSeenAt: host.lastSeenAt?.toISOString() ?? null,
          now: now.toISOString(),
          diffMs,
          thresholdMs: timeoutMs,
          jitterToleranceMs,
          intervalMs,
          activeSessions,
          offlineDurationMs: offlineDuration,
        });
      }

      await prisma.pC.updateMany({
        where: { hostId: host.id },
        data: { status: PCStatus.OFFLINE },
      });

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
      offlineTransitions += 1;
    }),
  );

  return offlineTransitions;
}
