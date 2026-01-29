import { PrismaClient, UserRole, PCLevel } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createSession } from '../services/sessionService.js';

const hasDatabase = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDatabase)('session lock', () => {
  const prisma = new PrismaClient();
  let pcId = '';
  let clientUserId = '';
  let hostUserId = '';

  beforeAll(async () => {
    await prisma.$connect();

    const client = await prisma.user.create({
      data: {
        name: 'Cliente Teste',
        email: `cliente-${Date.now()}@test.dev`,
        role: UserRole.CLIENT,
        wallet: { create: { balance: 50 } },
      },
    });
    clientUserId = client.id;

    const hostUser = await prisma.user.create({
      data: {
        name: 'Host Teste',
        email: `host-${Date.now()}@test.dev`,
        role: UserRole.HOST,
        host: { create: { displayName: 'Host Teste' } },
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
