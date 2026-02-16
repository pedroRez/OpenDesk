import { PCLevel, PrismaClient, SessionStatus, UserRole } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createSession, endSession, startSession } from '../services/sessionService.js';

const hasDatabase = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDatabase)('session end resilience', () => {
  let prisma: PrismaClient;
  let pcId = '';
  let clientUserId = '';
  let hostUserId = '';
  let hostId = '';

  beforeAll(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();

    const timestamp = Date.now();

    const client = await prisma.user.create({
      data: {
        email: `cliente-end-${timestamp}@test.dev`,
        username: `cliente-end-${timestamp}`,
        displayName: 'Cliente End Session',
        passwordHash: 'hash',
        authProvider: 'PASSWORD',
        role: UserRole.CLIENT,
        wallet: { create: { balance: 100 } },
      },
    });
    clientUserId = client.id;

    const hostUser = await prisma.user.create({
      data: {
        email: `host-end-${timestamp}@test.dev`,
        username: `host-end-${timestamp}`,
        displayName: 'Host End Session',
        passwordHash: 'hash',
        authProvider: 'PASSWORD',
        role: UserRole.HOST,
        host: { create: { displayName: `host-end-${timestamp}` } },
      },
      include: { host: true },
    });
    hostUserId = hostUser.id;
    hostId = hostUser.host!.id;

    const pc = await prisma.pC.create({
      data: {
        hostId,
        name: 'PC End Session',
        level: PCLevel.B,
        cpu: 'i5',
        ramGb: 16,
        gpu: 'RTX 3060',
        vramGb: 8,
        storageType: 'SSD',
        internetUploadMbps: 200,
        pricePerHour: 20,
      },
    });
    pcId = pc.id;
  });

  afterAll(async () => {
    await prisma.session.deleteMany({ where: { pcId } });
    await prisma.pC.deleteMany({ where: { id: pcId } });
    await prisma.reliabilityEvent.deleteMany({ where: { hostId } });
    await prisma.user.deleteMany({ where: { id: clientUserId } });
    await prisma.user.deleteMany({ where: { id: hostUserId } });
    await prisma.$disconnect();
  });

  it('recreates missing wallet while ending host-failure sessions', async () => {
    const session = await createSession({
      prisma,
      pcId,
      clientId: clientUserId,
      minutesPurchased: 30,
    });

    await startSession({ prisma, sessionId: session.id });

    await prisma.session.update({
      where: { id: session.id },
      data: { startAt: new Date(Date.now() - 3 * 60000) },
    });

    await prisma.wallet.delete({ where: { userId: clientUserId } });

    const ended = await endSession({
      prisma,
      sessionId: session.id,
      failureReason: 'HOST',
    });

    const wallet = await prisma.wallet.findUnique({ where: { userId: clientUserId } });

    expect(ended.status).toBe(SessionStatus.FAILED);
    expect(wallet).not.toBeNull();
    expect((wallet?.balance ?? 0)).toBeGreaterThan(0);
  });

  it('clamps minutesUsed to zero when startAt is in the future', async () => {
    const session = await createSession({
      prisma,
      pcId,
      clientId: clientUserId,
      minutesPurchased: 10,
      bypassCredits: true,
    });

    await startSession({ prisma, sessionId: session.id });

    await prisma.session.update({
      where: { id: session.id },
      data: { startAt: new Date(Date.now() + 2 * 60000) },
    });

    const ended = await endSession({
      prisma,
      sessionId: session.id,
      failureReason: 'NONE',
    });

    expect(ended.status).toBe(SessionStatus.ENDED);
    expect(ended.minutesUsed).toBe(0);
  });
});
