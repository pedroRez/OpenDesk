import type { FastifyReply, FastifyRequest } from 'fastify';
import type { PrismaClient, User, HostProfile } from '@prisma/client';

export type AuthUser = User & { host: HostProfile | null };

export async function requireUser(
  request: FastifyRequest,
  reply: FastifyReply,
  prisma: PrismaClient,
): Promise<AuthUser | null> {
  const header = request.headers['x-user-id'];
  const userId = Array.isArray(header) ? header[0] : header;

  if (!userId) {
    await reply.status(401).send({ error: 'Nao autenticado' });
    return null;
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { host: true },
  });

  if (!user) {
    await reply.status(401).send({ error: 'Usuario invalido' });
    return null;
  }

  return user;
}
