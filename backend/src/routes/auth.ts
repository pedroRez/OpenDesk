import { z } from 'zod';

import type { FastifyInstance } from 'fastify';

import {
  ensureUniqueUsername,
  hashPassword,
  normalizeUsername,
  usernameFromEmail,
  verifyGoogleToken,
  verifyPassword,
} from '../utils/authHelpers.js';

function sanitizeUser<T extends { passwordHash?: string | null; googleSub?: string | null }>(user: T) {
  const { passwordHash, googleSub, ...safe } = user;
  return safe;
}

export async function authRoutes(fastify: FastifyInstance) {
  fastify.post('/auth/register', async (request, reply) => {
    const schema = z.object({
      email: z.string().email(),
      password: z.string().min(6),
      username: z.string().min(3).max(20),
      displayName: z.string().max(40).optional(),
      role: z.enum(['CLIENT', 'HOST', 'ADMIN']).default('CLIENT'),
    });

    const body = schema.parse(request.body);

    const existingEmail = await fastify.prisma.user.findUnique({ where: { email: body.email } });
    if (existingEmail) {
      return reply.status(409).send({ error: 'Email ja cadastrado' });
    }

    const normalizedUsername = normalizeUsername(body.username);
    if (normalizedUsername.length < 3) {
      return reply.status(400).send({ error: 'Username invalido' });
    }
    const existingUsername = await fastify.prisma.user.findUnique({
      where: { username: normalizedUsername },
    });
    if (existingUsername) {
      return reply.status(409).send({ error: 'Username ja em uso' });
    }

    const passwordHash = await hashPassword(body.password);
    const user = await fastify.prisma.user.create({
      data: {
        email: body.email,
        username: normalizedUsername,
        displayName: body.displayName ?? null,
        passwordHash,
        authProvider: 'PASSWORD',
        role: body.role,
        wallet: { create: { balance: 0 } },
        host: body.role === 'HOST' ? { create: { displayName: normalizedUsername } } : undefined,
      },
      include: { host: true },
    });

    return reply.send({
      token: 'mock-token',
      user: sanitizeUser(user),
      userId: user.id,
      role: user.role,
      hostProfileId: user.host?.id ?? null,
    });
  });

  fastify.post('/auth/login', async (request, reply) => {
    const schema = z.object({
      email: z.string().email(),
      password: z.string().min(6),
    });

    const body = schema.parse(request.body);
    const user = await fastify.prisma.user.findUnique({
      where: { email: body.email },
      include: { wallet: true, host: true },
    });

    if (!user) {
      return reply.status(401).send({ error: 'Usuario nao encontrado' });
    }

    if (user.authProvider === 'GOOGLE') {
      return reply.status(401).send({ error: 'Use login com Google' });
    }

    if (!user.passwordHash) {
      return reply.status(401).send({ error: 'Senha nao configurada' });
    }

    const ok = await verifyPassword(body.password, user.passwordHash);
    if (!ok) {
      return reply.status(401).send({ error: 'Credenciais invalidas' });
    }

    return reply.send({
      token: 'mock-token',
      user: sanitizeUser(user),
      userId: user.id,
      role: user.role,
      hostProfileId: user.host?.id ?? null,
    });
  });

  fastify.post('/auth/google', async (request, reply) => {
    const schema = z.object({ idToken: z.string().min(10) });
    const body = schema.parse(request.body);

    const clientId = process.env.GOOGLE_CLIENT_ID;
    if (!clientId) {
      return reply.status(500).send({ error: 'Google Client ID nao configurado' });
    }

    const payload = await verifyGoogleToken(body.idToken, clientId);
    if (!payload?.sub || !payload.email) {
      return reply.status(401).send({ error: 'Token Google invalido' });
    }

    const existingBySub = await fastify.prisma.user.findFirst({
      where: { googleSub: payload.sub },
      include: { host: true },
    });
    if (existingBySub) {
      return reply.send({
        token: 'mock-token',
        user: sanitizeUser(existingBySub),
        userId: existingBySub.id,
        role: existingBySub.role,
        hostProfileId: existingBySub.host?.id ?? null,
      });
    }

    const existingByEmail = await fastify.prisma.user.findUnique({ where: { email: payload.email } });
    if (existingByEmail) {
      if (existingByEmail.authProvider === 'PASSWORD') {
        return reply.status(409).send({ error: 'Email ja cadastrado com senha' });
      }

      const updated = await fastify.prisma.user.update({
        where: { id: existingByEmail.id },
        data: {
          googleSub: existingByEmail.googleSub ?? payload.sub,
          displayName: existingByEmail.displayName ?? payload.name ?? null,
          authProvider: 'GOOGLE',
        },
        include: { host: true },
      });

      return reply.send({
        token: 'mock-token',
        user: sanitizeUser(updated),
        userId: updated.id,
        role: updated.role,
        hostProfileId: updated.host?.id ?? null,
      });
    }

    const desiredUsername = usernameFromEmail(payload.email);
    const username = await ensureUniqueUsername(fastify.prisma, desiredUsername);

    const user = await fastify.prisma.user.create({
      data: {
        email: payload.email,
        username,
        displayName: payload.name ?? null,
        authProvider: 'GOOGLE',
        googleSub: payload.sub,
        role: 'CLIENT',
        wallet: { create: { balance: 0 } },
      },
      include: { host: true },
    });

    return reply.send({
      token: 'mock-token',
      user: sanitizeUser(user),
      userId: user.id,
      role: user.role,
      hostProfileId: user.host?.id ?? null,
    });
  });
}
