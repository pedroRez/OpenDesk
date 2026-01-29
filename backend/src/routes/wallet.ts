import { z } from 'zod';

import type { FastifyInstance } from 'fastify';

export async function walletRoutes(fastify: FastifyInstance) {
  fastify.get('/wallets/:userId', async (request, reply) => {
    const params = z.object({ userId: z.string() }).parse(request.params);
    const wallet = await fastify.prisma.wallet.findUnique({
      where: { userId: params.userId },
    });

    if (!wallet) {
      return reply.status(404).send({ error: 'Wallet não encontrada' });
    }

    return wallet;
  });

  fastify.post('/wallets/:userId/tx', async (request, reply) => {
    const params = z.object({ userId: z.string() }).parse(request.params);
    const schema = z.object({
      type: z.enum(['CREDIT', 'DEBIT']),
      amount: z.number().positive(),
      reason: z.string(),
      sessionId: z.string().optional(),
    });
    const body = schema.parse(request.body);

    const wallet = await fastify.prisma.wallet.findUnique({
      where: { userId: params.userId },
    });

    if (!wallet) {
      return reply.status(404).send({ error: 'Wallet não encontrada' });
    }

    if (body.type === 'DEBIT' && wallet.balance < body.amount) {
      return reply.status(400).send({ error: 'Saldo insuficiente' });
    }

    await fastify.prisma.wallet.update({
      where: { userId: params.userId },
      data: {
        balance:
          body.type === 'CREDIT'
            ? { increment: body.amount }
            : { decrement: body.amount },
      },
    });

    const tx = await fastify.prisma.walletTx.create({
      data: {
        userId: params.userId,
        type: body.type,
        amount: body.amount,
        reason: body.reason,
        sessionId: body.sessionId,
      },
    });

    return reply.send({ tx });
  });
}
