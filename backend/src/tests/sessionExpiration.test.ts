import { PCLevel, PrismaClient, UserRole } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createSession, startSession } from '../services/sessionService.js';
import { expireSessions } from '../services/sessionService.js';

const hasDatabase = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDatabase)('session expiration', () => {
  const prisma = new PrismaClient();
  let pcId = '';
  let clientUserId = '';
  let hostUserId = '';
  let hostId = '';

  beforeAll(async () => {
    await prisma.$connect();

    const client = await prisma.user.create({
      data: {
        name: 'Cliente Expiração',
        email: `cliente-expira-${Date.now()}@test.dev`,
        role: UserRole.CLIENT,
        wallet: { create: { balance: 100 } },
      },
    });
    clientUserId = client.id;

    const hostUser = await prisma.user.create({
      data: {
        name: 'Host Expiração',
        email: `host-expira-${Date.now()}@test.dev`,
        role: UserRole.HOST,
        host: { create: { displayName: 'Host Expiração' } },
      },
      include: { host: true },
    });
    hostUserId = hostUser.id;
    hostId = hostUser.host!.id;

    const pc = await prisma.pC.create({
      data: {
        hostId: hostId,
        name: 'PC Expiração',
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
