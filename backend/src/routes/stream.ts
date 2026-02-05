import { randomBytes } from 'crypto';
import { z } from 'zod';
import { PCStatus, SessionStatus } from '@prisma/client';

import type { FastifyInstance } from 'fastify';

import { requireUser } from '../utils/auth.js';

const TOKEN_TTL_MS = 60_000;

function generateToken(): string {
  return randomBytes(24).toString('base64url');
}

export async function streamRoutes(fastify: FastifyInstance) {
  fastify.post('/stream/connect-token', async (request, reply) => {
    const body = z.object({ pcId: z.string() }).parse(request.body);
    const user = await requireUser(request, reply, fastify.prisma);
    if (!user) return;

    const pc = await fastify.prisma.pC.findUnique({
      where: { id: body.pcId },
      select: { id: true, status: true, connectAddress: true, connectHint: true },
    });
    if (!pc) {
      fastify.log.warn({ pcId: body.pcId, userId: user.id }, 'Stream token error: PC not found');
      return reply.status(404).send({ error: 'PC nao encontrado' });
    }
    if (pc.status === PCStatus.OFFLINE) {
      fastify.log.warn({ pcId: pc.id, userId: user.id }, 'Stream token error: PC offline');
      return reply.status(409).send({ error: 'PC offline' });
    }

    const session = await fastify.prisma.session.findFirst({
      where: {
        pcId: pc.id,
        clientUserId: user.id,
        status: { in: [SessionStatus.PENDING, SessionStatus.ACTIVE] },
      },
      select: { id: true },
    });
    if (!session) {
      fastify.log.warn({ pcId: pc.id, userId: user.id }, 'Stream token error: not authorized');
      return reply.status(403).send({ error: 'Sem permissao para conectar' });
    }

    const token = generateToken();
    const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);

    await fastify.prisma.streamConnectToken.create({
      data: {
        token,
        pcId: pc.id,
        userId: user.id,
        expiresAt,
      },
    });

    fastify.log.info(
      { token, pcId: pc.id, userId: user.id, expiresAt: expiresAt.toISOString() },
      'Stream token created',
    );

    return reply.send({ token, expiresAt: expiresAt.toISOString() });
  });

  fastify.post('/stream/resolve', async (request, reply) => {
    const body = z.object({ token: z.string().min(10) }).parse(request.body);

    const record = await fastify.prisma.streamConnectToken.findUnique({
      where: { token: body.token },
      include: {
        pc: {
          select: {
            id: true,
            name: true,
            connectAddress: true,
            connectHint: true,
            connectionHost: true,
            connectionPort: true,
          },
        },
      },
    });

    if (!record) {
      fastify.log.warn({ token: body.token }, 'Stream token resolve error: not found');
      return reply.status(404).send({ error: 'Token nao encontrado' });
    }

    if (record.consumedAt) {
      fastify.log.warn({ token: body.token }, 'Stream token resolve error: already used');
      return reply.status(409).send({ error: 'Token ja utilizado' });
    }

    const now = new Date();
    if (record.expiresAt.getTime() <= now.getTime()) {
      fastify.log.warn(
        { token: body.token, expiresAt: record.expiresAt.toISOString() },
        'Stream token resolve error: expired',
      );
      return reply.status(410).send({ error: 'Token expirado' });
    }

    if (!record.pc.connectAddress) {
      const fallbackHost = record.pc.connectionHost ?? null;
      const fallbackPort = record.pc.connectionPort ?? null;
      if (fallbackHost && fallbackPort) {
        return reply.send({
          connectAddress: `${fallbackHost}:${fallbackPort}`,
          connectHint: record.pc.connectHint,
          pcName: record.pc.name,
        });
      }

      fastify.log.warn(
        {
          token: body.token,
          pcId: record.pcId,
          connectAddress: record.pc.connectAddress ?? null,
          connectionHost: fallbackHost,
          connectionPort: fallbackPort,
        },
        'Stream token resolve error: missing address',
      );
      return reply.status(409).send({
        error: 'Endereco de conexao indisponivel',
        missing: {
          connectAddress: !record.pc.connectAddress,
          connectionHost: !fallbackHost,
          connectionPort: !fallbackPort,
        },
      });
    }

    await fastify.prisma.streamConnectToken.update({
      where: { token: body.token },
      data: { consumedAt: now },
    });

    fastify.log.info(
      { token: body.token, pcId: record.pcId, consumedAt: now.toISOString() },
      'Stream token consumed',
    );

    return reply.send({
      connectAddress: record.pc.connectAddress,
      connectHint: record.pc.connectHint,
      pcName: record.pc.name,
    });
  });

  fastify.post('/stream/pairing', async (request, reply) => {
    const body = z.object({ pcId: z.string(), pin: z.string().min(1).max(12) }).parse(request.body);
    const user = await requireUser(request, reply, fastify.prisma);
    if (!user) return;

    const pc = await fastify.prisma.pC.findUnique({
      where: { id: body.pcId },
      select: { id: true, name: true },
    });
    if (!pc) {
      fastify.log.warn({ pcId: body.pcId, userId: user.id }, 'Stream pairing error: PC not found');
      return reply.status(404).send({ error: 'PC nao encontrado' });
    }

    const session = await fastify.prisma.session.findFirst({
      where: {
        pcId: pc.id,
        clientUserId: user.id,
        status: { in: [SessionStatus.PENDING, SessionStatus.ACTIVE] },
      },
      select: { id: true },
    });
    if (!session) {
      fastify.log.warn({ pcId: pc.id, userId: user.id }, 'Stream pairing error: not authorized');
      return reply.status(403).send({ error: 'Sem permissao para parear' });
    }

    fastify.log.info(
      { pcId: pc.id, pcName: pc.name, userId: user.id, pin: body.pin },
      'Stream pairing PIN received',
    );

    return reply.send({ ok: true });
  });
}
