import { type PrismaClient } from '@prisma/client';

export type ReliabilityEventType = 'HOST_DOWN' | 'SESSION_FAILED' | 'SESSION_OK';

const reliabilityDelta: Record<ReliabilityEventType, number> = {
  HOST_DOWN: -10,
  SESSION_FAILED: -2,
  SESSION_OK: 1,
};

export async function recordReliabilityEvent(
  prisma: PrismaClient,
  hostId: string,
  type: ReliabilityEventType,
): Promise<void> {
  const delta = reliabilityDelta[type];

  await prisma.reliabilityEvent.create({
    data: {
      hostId,
      type,
    },
  });

  const host = await prisma.hostProfile.findUnique({ where: { id: hostId } });
  if (!host) {
    return;
  }

  const nextScore = Math.min(100, Math.max(0, host.reliabilityScore + delta));
  await prisma.hostProfile.update({
    where: { id: hostId },
    data: { reliabilityScore: nextScore },
  });
}
