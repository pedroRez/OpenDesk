import type { FastifyReply, FastifyRequest } from 'fastify';
import type { PrismaClient, User, HostProfile } from '@prisma/client';
import { verifyAccessToken } from './jwt.js';

export type AuthUser = User & { host: HostProfile | null };

export async function requireUser(
  request: FastifyRequest,
  reply: FastifyReply,
  prisma: PrismaClient,
): Promise<AuthUser | null> {
  const authHeader = request.headers.authorization;
  let userId: string | null = null;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice('Bearer '.length).trim();
    const payload = verifyAccessToken(token);
    if (!payload) {
      await reply.status(401).send({ error: 'Nao autenticado' });
      return null;
    }
    userId = payload.sub;
  } else {
    const header = request.headers['x-user-id'];
    userId = Array.isArray(header) ? header[0] : header ?? null;
  }

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
