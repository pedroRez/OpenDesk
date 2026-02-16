import { PCLevel, PrismaClient, UserRole } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createSession, startSession } from '../services/sessionService.js';
import { expireSessions } from '../services/sessionService.js';

const hasDatabase = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDatabase)('session expiration', () => {
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
        email: `cliente-expira-${timestamp}@test.dev`,
        username: `cliente-expira-${timestamp}`,
        displayName: 'Cliente Expiracao',
        passwordHash: 'hash',
        authProvider: 'PASSWORD',
        role: UserRole.CLIENT,
        wallet: { create: { balance: 100 } },
      },
    });
    clientUserId = client.id;

    const hostUser = await prisma.user.create({
      data: {
        email: `host-expira-${timestamp}@test.dev`,
        username: `host-expira-${timestamp}`,
        displayName: 'Host Expiracao',
        passwordHash: 'hash',
        authProvider: 'PASSWORD',
        role: UserRole.HOST,
        host: { create: { displayName: `host-expira-${timestamp}` } },
      },
      include: { host: true },
    });
    hostUserId = hostUser.id;
    hostId = hostUser.host!.id;

    const pc = await prisma.pC.create({
      data: {
        hostId: hostId,
        name: 'PC Expiracao',
        level: PCLevel.B,
        cpu: 'i5',
        ramGb: 16,
        gpu: 'GTX 1660',
        vramGb: 6,
        storageType: 'SSD',
        internetUploadMbps: 200,
        pricePerHour: 12,
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

  it('ends sessions automatically after end time', async () => {
    const session = await createSession({
      prisma,
      pcId,
      clientId: clientUserId,
      minutesPurchased: 1,
    });

    await startSession({ prisma, sessionId: session.id });

    await prisma.session.update({
      where: { id: session.id },
      data: { endAt: new Date(Date.now() - 60000) },
    });

    const expiredCount = await expireSessions(prisma);

    expect(expiredCount).toBeGreaterThan(0);

    const updatedSession = await prisma.session.findUnique({
      where: { id: session.id },
      include: { pc: true },
    });

    expect(updatedSession?.status).toBe('ENDED');
    expect(updatedSession?.pc.status).toBe('ONLINE');
  });
});
