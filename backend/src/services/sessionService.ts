import { PCStatus, SessionStatus, WalletTxType, type PrismaClient } from '@prisma/client';
import { addMinutes } from 'date-fns';

import { config } from '../config.js';
import { calculateSettlement, type FailureReason } from '../utils/penalty.js';
import { recordReliabilityEvent, type ReliabilityEventType } from './hostReliability.js';

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

export async function createSession(params: {
  prisma: PrismaClient;
  pcId: string;
  clientId: string;
  minutesPurchased: number;
  bypassCredits?: boolean;
}): Promise<Session> {
  const { prisma, pcId, clientId, minutesPurchased, bypassCredits = false } = params;

  return prisma.$transaction(async (tx) => {
    const pcRows = await tx.$queryRaw<{
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

    const existingSession = await tx.session.findFirst({
      where: {
        pcId,
        status: { in: [SessionStatus.PENDING, SessionStatus.ACTIVE] },
      },
    });

    if (existingSession) {
      throw new SessionError('PC já reservado', 'PC_BUSY', 409);
    }

    const priceTotal = (pc.pricePerHour * minutesPurchased) / 60;

    const wallet = await tx.wallet.findUnique({ where: { userId: clientId } });
    if (!wallet) {
      if (bypassCredits) {
        await tx.wallet.create({ data: { userId: clientId, balance: 0 } });
      } else {
        throw new SessionError('Saldo insuficiente', 'SALDO_INSUFICIENTE', 400);
      }
    }
    if (!bypassCredits) {
      if (!wallet || wallet.balance < priceTotal) {
        throw new SessionError('Saldo insuficiente', 'SALDO_INSUFICIENTE', 400);
      }
    }

    const session = await tx.session.create({
      data: {
        pcId,
        clientUserId: clientId,
        status: SessionStatus.PENDING,
        minutesPurchased,
        priceTotal,
      },
    });

    if (!bypassCredits) {
      await tx.wallet.update({
        where: { userId: clientId },
        data: { balance: { decrement: priceTotal } },
      });

      await tx.walletTx.create({
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
  });
}

export async function startSession(params: {
  prisma: PrismaClient;
  sessionId: string;
}): Promise<Session> {
  const { prisma, sessionId } = params;

  return prisma.$transaction(async (tx) => {
    const session = await tx.session.findUnique({ where: { id: sessionId } });
    if (!session) {
      throw new SessionError('Sessão não encontrada', 'SESSION_NOT_FOUND', 404);
    }
    if (session.status !== SessionStatus.PENDING) {
      throw new SessionError('Sessão não está pendente', 'INVALID_STATUS', 409);
    }

    const pcRows = await tx.$queryRaw<{
      id: string;
      status: PCStatus;
    }[]>`
      SELECT "id", "status" FROM "PC" WHERE "id" = ${session.pcId} FOR UPDATE
    `;

    const pc = pcRows[0];
    if (!pc || pc.status !== PCStatus.ONLINE) {
      throw new SessionError('PC indisponível', 'PC_BUSY', 409);
    }

    await tx.pC.update({
      where: { id: session.pcId },
      data: { status: PCStatus.BUSY },
    });

    const now = new Date();
    const endAt = addMinutes(now, session.minutesPurchased);

    return tx.session.update({
      where: { id: session.id },
      data: { status: SessionStatus.ACTIVE, startAt: now, endAt },
    });
  });
}

export async function endSession(params: {
  prisma: PrismaClient;
  sessionId: string;
  failureReason?: string;
  hostFault?: boolean;
  releaseStatus?: PCStatus;
}): Promise<Session> {
  const { prisma, sessionId, failureReason, hostFault = false, releaseStatus } = params;

  return prisma.$transaction(async (tx) => {
    const session = await tx.session.findUnique({
      where: { id: sessionId },
      include: { pc: true },
    });
    if (!session) {
      throw new SessionError('Sessão não encontrada', 'SESSION_NOT_FOUND', 404);
    }
    if (session.status !== SessionStatus.ACTIVE) {
      throw new SessionError('Sessão não está ativa', 'INVALID_STATUS', 409);
    }

    const endTime = new Date();
    const startTime = session.startAt ?? endTime;
    const minutesUsed = Math.min(
      Math.ceil((endTime.getTime() - startTime.getTime()) / 60000),
      session.minutesPurchased,
    );

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
      await tx.wallet.update({
        where: { userId: session.clientUserId },
        data: { balance: { increment: settlement.clientCredit } },
      });
      await tx.walletTx.create({
        data: {
          userId: session.clientUserId,
          type: WalletTxType.CREDIT,
          amount: settlement.clientCredit,
          reason: 'Crédito por falha do host',
          sessionId: session.id,
        },
      });
    }

    const finalPcStatus = releaseStatus ?? PCStatus.ONLINE;

    await tx.pC.update({
      where: { id: session.pcId },
      data: { status: finalPcStatus },
    });

    const finalStatus = normalizedFailure === 'HOST' || normalizedFailure === 'PLATFORM'
      ? SessionStatus.FAILED
      : SessionStatus.ENDED;

    const updatedSession = await tx.session.update({
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

    const reliabilityType: ReliabilityEventType =
      finalStatus === SessionStatus.FAILED ? 'SESSION_FAILED' : 'SESSION_OK';

    await recordReliabilityEvent(tx, session.pc.hostId, reliabilityType);

    return updatedSession;
  });
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
