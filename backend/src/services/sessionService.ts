import { PCStatus, QueueEntryStatus, SessionStatus, WalletTxType, type PrismaClient } from '@prisma/client';
import { addMinutes } from 'date-fns';

import { config } from '../config.js';
import { calculateSettlement, type FailureReason } from '../utils/penalty.js';
import { recordReliabilityEvent, type ReliabilityEventType } from './hostReliability.js';
import { recordHostSessionEnd, recordHostSessionStart } from './hostReliabilityStats.js';

import type { Session } from '@prisma/client';

export class SessionError extends Error {
  code: string;
  status: number;

  constructor(message: string, code: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

type PrismaClientLike = PrismaClient | Prisma.TransactionClient;

const allowedFailureReasons: FailureReason[] = ['HOST', 'CLIENT', 'PLATFORM', 'NONE'];

function normalizeFailureReason(value?: string, hostFault?: boolean): FailureReason {
  if (hostFault) {
    return 'HOST';
  }
  if (!value) {
    return 'NONE';
  }
  if (allowedFailureReasons.includes(value as FailureReason)) {
    return value as FailureReason;
  }
  return 'NONE';
}

async function createSessionInternal(params: {
  prisma: PrismaClientLike;
  pcId: string;
  clientId: string;
  minutesPurchased: number;
  bypassCredits?: boolean;
}): Promise<Session> {
  const { prisma, pcId, clientId, minutesPurchased, bypassCredits = false } = params;

  const pcRows = await prisma.$queryRaw<{
    id: string;
    status: PCStatus;
    pricePerHour: number;
  }[]>`
      SELECT "id", "status", "pricePerHour" FROM "PC" WHERE "id" = ${pcId} FOR UPDATE
    `;

  const pc = pcRows[0];
  if (!pc) {
    throw new SessionError('PC não encontrado', 'PC_NOT_FOUND', 404);
  }
  if (pc.status === PCStatus.BUSY) {
    throw new SessionError('PC está ocupado', 'PC_BUSY', 409);
  }
  if (pc.status !== PCStatus.ONLINE) {
    throw new SessionError('PC indisponível', 'PC_OFFLINE', 409);
  }

  const existingSession = await prisma.session.findFirst({
    where: {
      pcId,
      status: { in: [SessionStatus.PENDING, SessionStatus.ACTIVE] },
    },
  });

  if (existingSession) {
    throw new SessionError('PC já reservado', 'PC_BUSY', 409);
  }

  const existingClientSession = await prisma.session.findFirst({
    where: {
      clientUserId: clientId,
      status: { in: [SessionStatus.PENDING, SessionStatus.ACTIVE] },
    },
  });

  if (existingClientSession) {
    throw new SessionError('Usuário já possui uma sessão ativa', 'SESSION_EXISTS', 409);
  }

  const priceTotal = (pc.pricePerHour * minutesPurchased) / 60;

  const wallet = await prisma.wallet.findUnique({ where: { userId: clientId } });
  if (!wallet) {
    if (bypassCredits) {
      await prisma.wallet.create({ data: { userId: clientId, balance: 0 } });
    } else {
      throw new SessionError('Saldo insuficiente', 'SALDO_INSUFICIENTE', 400);
    }
  }
  if (!bypassCredits) {
    if (!wallet || wallet.balance < priceTotal) {
      throw new SessionError('Saldo insuficiente', 'SALDO_INSUFICIENTE', 400);
    }
  }

  const session = await prisma.session.create({
    data: {
      pcId,
      clientUserId: clientId,
      status: SessionStatus.PENDING,
      minutesPurchased,
      priceTotal,
    },
  });

  if (!bypassCredits) {
    await prisma.wallet.update({
      where: { userId: clientId },
      data: { balance: { decrement: priceTotal } },
    });

    await prisma.walletTx.create({
      data: {
        userId: clientId,
        type: WalletTxType.DEBIT,
        amount: priceTotal,
        reason: 'Reserva de sessao',
        sessionId: session.id,
      },
    });
  }
  return session;
}

async function startSessionInternal(params: {
  prisma: PrismaClientLike;
  sessionId: string;
}): Promise<Session> {
  const { prisma, sessionId } = params;

  const session = await prisma.session.findUnique({ where: { id: sessionId } });
  if (!session) {
    throw new SessionError('Sessão não encontrada', 'SESSION_NOT_FOUND', 404);
  }
  if (session.status !== SessionStatus.PENDING) {
    throw new SessionError('Sessão não está pendente', 'INVALID_STATUS', 409);
  }

  const pcRows = await prisma.$queryRaw<{
    id: string;
    status: PCStatus;
    hostId: string;
  }[]>`
      SELECT "id", "status", "hostId" FROM "PC" WHERE "id" = ${session.pcId} FOR UPDATE
    `;

  const pc = pcRows[0];
  if (!pc || pc.status !== PCStatus.ONLINE) {
    throw new SessionError('PC indisponível', 'PC_BUSY', 409);
  }

  await prisma.pC.update({
    where: { id: session.pcId },
    data: { status: PCStatus.BUSY },
  });

  const now = new Date();
  const endAt = addMinutes(now, session.minutesPurchased);

  const updatedSession = await prisma.session.update({
    where: { id: session.id },
    data: { status: SessionStatus.ACTIVE, startAt: now, endAt },
  });

  await prisma.queueEntry.updateMany({
    where: {
      pcId: session.pcId,
      userId: session.clientUserId,
      status: QueueEntryStatus.PROMOTED,
    },
    data: { status: QueueEntryStatus.ACTIVE },
  });

  await recordHostSessionStart(prisma, pc.hostId);

  return updatedSession;
}

export async function createSession(params: {
  prisma: PrismaClient;
  pcId: string;
  clientId: string;
  minutesPurchased: number;
  bypassCredits?: boolean;
}): Promise<Session> {
  const { prisma, pcId, clientId, minutesPurchased, bypassCredits = false } = params;

  return prisma.$transaction(async (tx) =>
    createSessionInternal({ prisma: tx, pcId, clientId, minutesPurchased, bypassCredits }),
  );
}

export async function startSession(params: {
  prisma: PrismaClient;
  sessionId: string;
}): Promise<Session> {
  const { prisma, sessionId } = params;

  return prisma.$transaction(async (tx) => startSessionInternal({ prisma: tx, sessionId }));
}

export async function createAndStartSession(params: {
  prisma: PrismaClientLike;
  pcId: string;
  clientId: string;
  minutesPurchased: number;
  bypassCredits?: boolean;
}): Promise<Session> {
  const { prisma, pcId, clientId, minutesPurchased, bypassCredits } = params;
  const session = await createSessionInternal({
    prisma,
    pcId,
    clientId,
    minutesPurchased,
    bypassCredits,
  });
  return startSessionInternal({ prisma, sessionId: session.id });
}

async function promoteNextInQueue(prisma: PrismaClient, pcId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const pcRows = await tx.$queryRaw<{ id: string; status: PCStatus }[]>`
      SELECT "id", "status" FROM "PC" WHERE "id" = ${pcId} FOR UPDATE
    `;
    const pc = pcRows[0];
    if (!pc || pc.status === PCStatus.OFFLINE) {
      return;
    }
    if (pc.status === PCStatus.BUSY) {
      return;
    }

    const activeSession = await tx.session.findFirst({
      where: {
        pcId,
        status: { in: [SessionStatus.PENDING, SessionStatus.ACTIVE] },
      },
      select: { id: true },
    });

    if (activeSession) {
      return;
    }

    const existingPromoted = await tx.queueEntry.findFirst({
      where: { pcId, status: QueueEntryStatus.PROMOTED },
    });
    if (existingPromoted) {
      return;
    }

    let entry = await tx.queueEntry.findFirst({
      where: { pcId, status: QueueEntryStatus.WAITING },
      orderBy: { createdAt: 'asc' },
    });

    while (entry) {
      try {
        const session = await createSessionInternal({
          prisma: tx,
          pcId,
          clientId: entry.userId,
          minutesPurchased: entry.minutesPurchased,
        });

        const startBy = new Date(Date.now() + config.queuePromotionTtlSeconds * 1000);
        await tx.queueEntry.update({
          where: { id: entry.id },
          data: { status: QueueEntryStatus.PROMOTED, startBy },
        });
        return;
      } catch (error) {
        if (error instanceof SessionError && error.code === 'SALDO_INSUFICIENTE') {
          await tx.queueEntry.update({
            where: { id: entry.id },
            data: { status: QueueEntryStatus.CANCELLED },
          });
          entry = await tx.queueEntry.findFirst({
            where: { pcId, status: QueueEntryStatus.WAITING },
            orderBy: { createdAt: 'asc' },
          });
          continue;
        }
        if (error instanceof SessionError && ['PC_OFFLINE', 'PC_BUSY', 'SESSION_EXISTS'].includes(error.code)) {
          return;
        }
        throw error;
      }
    }
  });
}

async function cancelPendingSessionForUser(params: {
  prisma: PrismaClient;
  pcId: string;
  userId: string;
  failureReason: string;
}): Promise<void> {
  const { prisma, pcId, userId, failureReason } = params;
  const session = await prisma.session.findFirst({
    where: {
      pcId,
      clientUserId: userId,
      status: SessionStatus.PENDING,
    },
  });
  if (!session) return;

  const debitTx = await prisma.walletTx.findFirst({
    where: { sessionId: session.id, type: WalletTxType.DEBIT },
  });

  await prisma.session.update({
    where: { id: session.id },
    data: { status: SessionStatus.FAILED, endAt: new Date(), failureReason },
  });

  if (debitTx) {
    await prisma.wallet.update({
      where: { userId: session.clientUserId },
      data: { balance: { increment: session.priceTotal } },
    });
    await prisma.walletTx.create({
      data: {
        userId: session.clientUserId,
        type: WalletTxType.CREDIT,
        amount: session.priceTotal,
        reason: 'Sessao nao iniciada',
        sessionId: session.id,
      },
    });
  }
}

export async function promoteQueueForPc(prisma: PrismaClient, pcId: string): Promise<void> {
  await promoteNextInQueue(prisma, pcId);
}

export async function clearQueueForPc(prisma: PrismaClient, pcId: string): Promise<void> {
  await prisma.queueEntry.updateMany({
    where: { pcId, status: { in: [QueueEntryStatus.WAITING, QueueEntryStatus.PROMOTED] } },
    data: { status: QueueEntryStatus.CANCELLED },
  });
}

export async function expirePromotedSlots(prisma: PrismaClient): Promise<number> {
  const now = new Date();
  const expired = await prisma.queueEntry.findMany({
    where: {
      status: QueueEntryStatus.PROMOTED,
      startBy: { lt: now },
    },
    select: { id: true, pcId: true, userId: true },
  });

  if (expired.length === 0) return 0;

  await Promise.all(
    expired.map((entry) =>
      cancelPendingSessionForUser({
        prisma,
        pcId: entry.pcId,
        userId: entry.userId,
        failureReason: 'QUEUE_TIMEOUT',
      }),
    ),
  );

  await prisma.queueEntry.updateMany({
    where: { id: { in: expired.map((entry) => entry.id) } },
    data: { status: QueueEntryStatus.CANCELLED },
  });

  const uniquePcIds = Array.from(new Set(expired.map((entry) => entry.pcId)));
  await Promise.all(uniquePcIds.map((pcId) => promoteNextInQueue(prisma, pcId)));

  return expired.length;
}

export async function endSession(params: {
  prisma: PrismaClient;
  sessionId: string;
  failureReason?: string;
  hostFault?: boolean;
  releaseStatus?: PCStatus;
}): Promise<Session> {
  const { prisma, sessionId, failureReason, hostFault = false, releaseStatus } = params;

  const updatedSession = await prisma.$transaction(async (tx) => {
    const session = await tx.session.findUnique({
      where: { id: sessionId },
      include: { pc: true },
    });
    if (!session) {
      throw new SessionError('Sessao nao encontrada', 'SESSION_NOT_FOUND', 404);
    }
    if (session.status !== SessionStatus.ACTIVE) {
      throw new SessionError('Sessao nao esta ativa', 'INVALID_STATUS', 409);
    }

    const endTime = new Date();
    const startTime = session.startAt ?? endTime;
    const elapsedMinutes = Math.ceil((endTime.getTime() - startTime.getTime()) / 60000);
    const minutesUsed = Math.max(0, Math.min(elapsedMinutes, session.minutesPurchased));

    const normalizedFailure = normalizeFailureReason(failureReason, hostFault);

    const settlement = calculateSettlement({
      minutesUsed,
      minutesPurchased: session.minutesPurchased,
      pricePerHour: session.pc.pricePerHour,
      platformFeePercent: config.platformFeeRate,
      penaltyPercent: config.hostPenaltyRate,
      failureReason: normalizedFailure,
    });

    if (settlement.clientCredit > 0) {
      await tx.wallet.upsert({
        where: { userId: session.clientUserId },
        create: { userId: session.clientUserId, balance: settlement.clientCredit },
        update: { balance: { increment: settlement.clientCredit } },
      });
      await tx.walletTx.create({
        data: {
          userId: session.clientUserId,
          type: WalletTxType.CREDIT,
          amount: settlement.clientCredit,
          reason: 'Credito por falha do host',
          sessionId: session.id,
        },
      });
    }

    const finalPcStatus = releaseStatus ??
      (session.pc.status === PCStatus.OFFLINE ? PCStatus.OFFLINE : PCStatus.ONLINE);

    await tx.pC.update({
      where: { id: session.pcId },
      data: { status: finalPcStatus },
    });

    const finalStatus = normalizedFailure === 'HOST' || normalizedFailure === 'PLATFORM'
      ? SessionStatus.FAILED
      : SessionStatus.ENDED;

    const updated = await tx.session.update({
      where: { id: session.id },
      data: {
        status: finalStatus,
        endAt: endTime,
        minutesUsed,
        platformFee: settlement.platformFee,
        hostPayout: settlement.hostPayout,
        clientCredit: settlement.clientCredit,
        failureReason: normalizedFailure,
      },
    });

    await tx.queueEntry.updateMany({
      where: {
        pcId: session.pcId,
        userId: session.clientUserId,
        status: { in: [QueueEntryStatus.ACTIVE, QueueEntryStatus.PROMOTED] },
      },
      data: { status: QueueEntryStatus.EXPIRED },
    });

    await tx.streamConnectToken.updateMany({
      where: {
        pcId: session.pcId,
        userId: session.clientUserId,
        consumedAt: null,
      },
      data: { consumedAt: endTime },
    });

    const reliabilityType: ReliabilityEventType =
      finalStatus === SessionStatus.FAILED ? 'SESSION_FAILED' : 'SESSION_OK';

    await recordReliabilityEvent(tx, session.pc.hostId, reliabilityType);
    await recordHostSessionEnd(tx, session.pc.hostId, {
      status: finalStatus === SessionStatus.FAILED ? 'DROPPED' : 'COMPLETED',
      endedAt: endTime,
    });

    return updated;
  });

  try {
    await promoteNextInQueue(prisma, updatedSession.pcId);
  } catch (error) {
    console.error('Failed to promote queue after session end', error);
  }

  return updatedSession;
}

export async function expireSessions(prisma: PrismaClient): Promise<number> {
  const expired = await prisma.session.findMany({
    where: {
      status: SessionStatus.ACTIVE,
      endAt: { lt: new Date() },
    },
  });

  await Promise.all(
    expired.map((session) =>
      endSession({
        prisma,
        sessionId: session.id,
        failureReason: 'NONE',
      }),
    ),
  );

  return expired.length;
}
