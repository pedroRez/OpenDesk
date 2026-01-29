import { PCStatus, SessionStatus, WalletTxType } from '@prisma/client';
import { addMinutes } from 'date-fns';

import { config } from '../config.js';
import { calculatePenalty } from '../utils/penalty.js';

import type { PrismaClient, Session } from '@prisma/client';

export class SessionError extends Error {}

export async function createSession(params: {
  prisma: PrismaClient;
  pcId: string;
  clientUserId: string;
  minutesPurchased: number;
}): Promise<Session> {
  const { prisma, pcId, clientUserId, minutesPurchased } = params;

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
      throw new SessionError('PC não encontrado');
    }
    if (pc.status === PCStatus.BUSY) {
      throw new SessionError('PC está ocupado');
    }

    const existingSession = await tx.session.findFirst({
      where: {
        pcId,
        status: { in: [SessionStatus.PENDING, SessionStatus.ACTIVE] },
      },
    });

    if (existingSession) {
      throw new SessionError('PC já reservado');
    }

    const priceTotal = (pc.pricePerHour * minutesPurchased) / 60;

    const wallet = await tx.wallet.findUnique({ where: { userId: clientUserId } });
    if (!wallet || wallet.balance < priceTotal) {
      throw new SessionError('Saldo insuficiente');
    }

    const session = await tx.session.create({
      data: {
        pcId,
        clientUserId,
        status: SessionStatus.PENDING,
        minutesPurchased,
        priceTotal,
      },
    });

    await tx.wallet.update({
      where: { userId: clientUserId },
      data: { balance: { decrement: priceTotal } },
    });

    await tx.walletTx.create({
      data: {
        userId: clientUserId,
        type: WalletTxType.DEBIT,
        amount: priceTotal,
        reason: 'Reserva de sessão',
        sessionId: session.id,
      },
    });

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
      throw new SessionError('Sessão não encontrada');
    }
    if (session.status !== SessionStatus.PENDING) {
      throw new SessionError('Sessão não está pendente');
    }

    const pcRows = await tx.$queryRaw<{
      id: string;
      status: PCStatus;
    }[]>`
      SELECT "id", "status" FROM "PC" WHERE "id" = ${session.pcId} FOR UPDATE
    `;

    const pc = pcRows[0];
    if (!pc || pc.status === PCStatus.BUSY) {
      throw new SessionError('PC indisponível');
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
}): Promise<Session> {
  const { prisma, sessionId, failureReason, hostFault = false } = params;

  return prisma.$transaction(async (tx) => {
    const session = await tx.session.findUnique({ where: { id: sessionId } });
    if (!session) {
      throw new SessionError('Sessão não encontrada');
    }

    const endTime = new Date();
    const startTime = session.startAt ?? endTime;
    const minutesUsed = Math.min(
      Math.ceil((endTime.getTime() - startTime.getTime()) / 60000),
      session.minutesPurchased,
    );

    let platformFee = session.priceTotal * config.platformFeeRate;
    let hostPayout = session.priceTotal - platformFee;
    let clientCredit = 0;

    if (hostFault) {
      const penaltyResult = calculatePenalty({
        minutesUsed,
        minutesPurchased: session.minutesPurchased,
        priceTotal: session.priceTotal,
        penaltyRate: 0.2,
        platformFeeRate: config.platformFeeRate,
      });
      platformFee = penaltyResult.platformFee;
      hostPayout = penaltyResult.hostPayout;
      clientCredit = penaltyResult.clientCredit;

      if (clientCredit > 0) {
        await tx.wallet.update({
          where: { userId: session.clientUserId },
          data: { balance: { increment: clientCredit } },
        });
        await tx.walletTx.create({
          data: {
            userId: session.clientUserId,
            type: WalletTxType.CREDIT,
            amount: clientCredit,
            reason: 'Crédito por falha do host',
            sessionId: session.id,
          },
        });
      }
    }

    await tx.pC.update({
      where: { id: session.pcId },
      data: { status: PCStatus.ONLINE },
    });

    return tx.session.update({
      where: { id: session.id },
      data: {
        status: hostFault ? SessionStatus.FAILED : SessionStatus.ENDED,
        endAt: endTime,
        minutesUsed,
        platformFee,
        hostPayout,
        clientCredit,
        failureReason: failureReason ?? null,
      },
    });
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
      endSession({ prisma, sessionId: session.id, failureReason: 'Tempo expirado' }),
    ),
  );

  return expired.length;
}
