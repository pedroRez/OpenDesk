import { PrismaClient, UserRole, PCLevel, PCStatus } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const clientUser = await prisma.user.create({
    data: {
      name: 'Cliente Demo',
      email: 'cliente@opendesk.dev',
      role: UserRole.CLIENT,
      wallet: { create: { balance: 100 } },
    },
  });

  const hostUser = await prisma.user.create({
    data: {
      name: 'Host Demo',
      email: 'host@opendesk.dev',
      role: UserRole.HOST,
      wallet: { create: { balance: 0 } },
      host: {
        create: {
          displayName: 'Host Gamer',
          reliabilityScore: 0.95,
        },
      },
    },
    include: { host: true },
  });

  const pc = await prisma.pC.create({
    data: {
      hostId: hostUser.host!.id,
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

  const software = await prisma.software.createMany({
    data: [
      { name: 'Blender', category: '3D' },
      { name: 'Adobe Premiere', category: 'Video' },
      { name: 'Unity', category: 'Game Dev' },
    ],
  });

  const softwareList = await prisma.software.findMany();

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
