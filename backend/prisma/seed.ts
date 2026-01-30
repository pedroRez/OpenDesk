import { PrismaClient, UserRole, PCLevel, PCStatus } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const clientUser = await prisma.user.upsert({
    where: { email: 'cliente@opendesk.dev' },
    update: {
      name: 'Cliente Demo',
      role: UserRole.CLIENT,
    },
    create: {
      name: 'Cliente Demo',
      email: 'cliente@opendesk.dev',
      role: UserRole.CLIENT,
    },
  });

  await prisma.wallet.upsert({
    where: { userId: clientUser.id },
    update: { balance: 100 },
    create: { userId: clientUser.id, balance: 100 },
  });

  const hostUser = await prisma.user.upsert({
    where: { email: 'host@opendesk.dev' },
    update: {
      name: 'Host Demo',
      role: UserRole.HOST,
    },
    create: {
      name: 'Host Demo',
      email: 'host@opendesk.dev',
      role: UserRole.HOST,
    },
  });

  await prisma.wallet.upsert({
    where: { userId: hostUser.id },
    update: { balance: 0 },
    create: { userId: hostUser.id, balance: 0 },
  });

  const hostProfile = await prisma.hostProfile.upsert({
    where: { userId: hostUser.id },
    update: {
      displayName: 'Host Gamer',
      reliabilityScore: 0.95,
    },
    create: {
      userId: hostUser.id,
      displayName: 'Host Gamer',
      reliabilityScore: 0.95,
    },
  });

  const existingPc = await prisma.pC.findFirst({
    where: { hostId: hostProfile.id, name: 'PC RTX 4080' },
  });

  const pc = existingPc
    ? await prisma.pC.update({
        where: { id: existingPc.id },
        data: {
          level: PCLevel.A,
          cpu: 'Ryzen 9 7900X',
          ramGb: 64,
          gpu: 'RTX 4080',
          vramGb: 16,
          storageType: 'NVMe',
          internetUploadMbps: 500,
          pricePerHour: 15,
          status: PCStatus.ONLINE,
        },
      })
    : await prisma.pC.create({
        data: {
          hostId: hostProfile.id,
          name: 'PC RTX 4080',
          level: PCLevel.A,
          cpu: 'Ryzen 9 7900X',
          ramGb: 64,
          gpu: 'RTX 4080',
          vramGb: 16,
          storageType: 'NVMe',
          internetUploadMbps: 500,
          pricePerHour: 15,
          status: PCStatus.ONLINE,
        },
      });

  const softwareSeed = [
    { name: 'Blender', category: '3D' },
    { name: 'Adobe Premiere', category: 'Video' },
    { name: 'Unity', category: 'Game Dev' },
  ];

  const softwareList = [];
  for (const item of softwareSeed) {
    const existing = await prisma.software.findFirst({ where: { name: item.name } });
    const record = existing
      ? await prisma.software.update({
          where: { id: existing.id },
          data: { category: item.category },
        })
      : await prisma.software.create({ data: item });
    softwareList.push(record);
  }

  await prisma.pCSoftware.deleteMany({ where: { pcId: pc.id } });
  await prisma.pCSoftware.createMany({
    data: softwareList.map((item) => ({
      pcId: pc.id,
      softwareId: item.id,
    })),
  });

  console.log('Seed completed', { clientUser, hostUser });
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
