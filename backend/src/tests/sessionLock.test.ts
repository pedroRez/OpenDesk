import { PrismaClient, UserRole, PCLevel } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createSession } from '../services/sessionService.js';

const hasDatabase = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDatabase)('session lock', () => {
  let prisma: PrismaClient;
  let pcId = '';
  let clientUserId = '';
  let hostUserId = '';

  beforeAll(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();

    const timestamp = Date.now();

    const client = await prisma.user.create({
      data: {
        email: `cliente-${timestamp}@test.dev`,
        username: `cliente-${timestamp}`,
        displayName: 'Cliente Teste',
        passwordHash: 'hash',
        authProvider: 'PASSWORD',
        role: UserRole.CLIENT,
        wallet: { create: { balance: 50 } },
      },
    });
    clientUserId = client.id;

    const hostUser = await prisma.user.create({
      data: {
        email: `host-${timestamp}@test.dev`,
        username: `host-${timestamp}`,
        displayName: 'Host Teste',
        passwordHash: 'hash',
        authProvider: 'PASSWORD',
        role: UserRole.HOST,
        host: { create: { displayName: `host-${timestamp}` } },
      },
      include: { host: true },
    });
    hostUserId = hostUser.id;

    const pc = await prisma.pC.create({
      data: {
        hostId: hostUser.host!.id,
        name: 'PC Teste',
        level: PCLevel.B,
        cpu: 'i5',
        ramGb: 16,
        gpu: 'GTX 1660',
        vramGb: 6,
        storageType: 'SSD',
        internetUploadMbps: 200,
        pricePerHour: 10,
      },
    });
    pcId = pc.id;
  });

  afterAll(async () => {
    await prisma.session.deleteMany({ where: { pcId } });
    await prisma.pC.deleteMany({ where: { id: pcId } });
    await prisma.user.deleteMany({ where: { id: clientUserId } });
    await prisma.user.deleteMany({ where: { id: hostUserId } });
    await prisma.$disconnect();
  });

  it('allows only one pending session per PC', async () => {
    const results = await Promise.allSettled([
      createSession({ prisma, pcId, clientId: clientUserId, minutesPurchased: 60 }),
      createSession({ prisma, pcId, clientId: clientUserId, minutesPurchased: 60 }),
    ]);

    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
  });
});
