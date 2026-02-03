import type { PrismaClient, Prisma } from '@prisma/client';

export type ReliabilityBadge = 'CONFIAVEL' | 'NOVO' | 'INSTAVEL';

export type ReliabilityStats = {
  sessionsTotal: number;
  sessionsCompleted: number;
  sessionsDropped: number;
  onlineMinutes7d: number;
  lastDropAt: Date | null;
};

type PrismaClientLike = PrismaClient | Prisma.TransactionClient;

type HostReliabilitySnapshot = {
  id: string;
  sessionsTotal: number;
  sessionsCompleted: number;
  sessionsDropped: number;
  lastDropAt: Date | null;
};

const NEW_HOST_SESSION_THRESHOLD = 5;
const COMPLETION_RATE_THRESHOLD = 0.9;
const ONLINE_LOOKBACK_DAYS = 7;

export function getReliabilityBadge(params: {
  sessionsTotal: number;
  sessionsCompleted: number;
}): ReliabilityBadge {
  if (params.sessionsTotal < NEW_HOST_SESSION_THRESHOLD) {
    return 'NOVO';
  }
  const completionRate =
    params.sessionsTotal > 0 ? params.sessionsCompleted / params.sessionsTotal : 0;
  return completionRate >= COMPLETION_RATE_THRESHOLD ? 'CONFIAVEL' : 'INSTAVEL';
}

export async function recordHostSessionStart(
  prisma: PrismaClientLike,
  hostId: string,
): Promise<void> {
  await prisma.hostProfile.update({
    where: { id: hostId },
    data: { sessionsTotal: { increment: 1 } },
  });
}

export async function recordHostSessionEnd(
  prisma: PrismaClientLike,
  hostId: string,
  params: { status: 'COMPLETED' | 'DROPPED'; endedAt: Date },
): Promise<void> {
  if (params.status === 'COMPLETED') {
    await prisma.hostProfile.update({
      where: { id: hostId },
      data: { sessionsCompleted: { increment: 1 } },
    });
    return;
  }

  await prisma.hostProfile.update({
    where: { id: hostId },
    data: {
      sessionsDropped: { increment: 1 },
      lastDropAt: params.endedAt,
    },
  });
}

export async function recordHostDrop(
  prisma: PrismaClientLike,
  hostId: string,
  dropAt: Date,
): Promise<void> {
  await prisma.hostProfile.update({
    where: { id: hostId },
    data: { lastDropAt: dropAt },
  });
}

export async function recordHostOnlineMinute(
  prisma: PrismaClientLike,
  hostId: string,
  seenAt: Date,
): Promise<void> {
  const minute = new Date(seenAt);
  minute.setSeconds(0, 0);

  await prisma.hostOnlineMinute.upsert({
    where: {
      hostId_minute: {
        hostId,
        minute,
      },
    },
    update: {},
    create: {
      hostId,
      minute,
    },
  });
}

export async function getReliabilityStats(
  prisma: PrismaClient,
  hostId: string,
): Promise<{ stats: ReliabilityStats; badge: ReliabilityBadge } | null> {
  const host = await prisma.hostProfile.findUnique({
    where: { id: hostId },
    select: {
      id: true,
      sessionsTotal: true,
      sessionsCompleted: true,
      sessionsDropped: true,
      lastDropAt: true,
    },
  });

  if (!host) return null;

  const onlineMinutes7d = await countOnlineMinutes(prisma, [host.id]);
  const stats = buildStats(host, onlineMinutes7d.get(host.id) ?? 0);
  const badge = getReliabilityBadge(stats);

  return { stats, badge };
}

export async function getReliabilityStatsMap(
  prisma: PrismaClient,
  hostIds: string[],
): Promise<Map<string, { stats: ReliabilityStats; badge: ReliabilityBadge }>> {
  if (hostIds.length === 0) return new Map();

  const hosts = await prisma.hostProfile.findMany({
    where: { id: { in: hostIds } },
    select: {
      id: true,
      sessionsTotal: true,
      sessionsCompleted: true,
      sessionsDropped: true,
      lastDropAt: true,
    },
  });

  const onlineMinutes = await countOnlineMinutes(prisma, hostIds);

  const map = new Map<string, { stats: ReliabilityStats; badge: ReliabilityBadge }>();
  hosts.forEach((host) => {
    const stats = buildStats(host, onlineMinutes.get(host.id) ?? 0);
    map.set(host.id, { stats, badge: getReliabilityBadge(stats) });
  });

  return map;
}

function buildStats(host: HostReliabilitySnapshot, onlineMinutes7d: number): ReliabilityStats {
  return {
    sessionsTotal: host.sessionsTotal ?? 0,
    sessionsCompleted: host.sessionsCompleted ?? 0,
    sessionsDropped: host.sessionsDropped ?? 0,
    onlineMinutes7d,
    lastDropAt: host.lastDropAt ?? null,
  };
}

async function countOnlineMinutes(
  prisma: PrismaClient,
  hostIds: string[],
): Promise<Map<string, number>> {
  const since = new Date(Date.now() - ONLINE_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);

  const counts = await prisma.hostOnlineMinute.groupBy({
    by: ['hostId'],
    where: {
      hostId: { in: hostIds },
      minute: { gte: since },
    },
    _count: { _all: true },
  });

  return new Map(counts.map((item) => [item.hostId, item._count._all]));
}
