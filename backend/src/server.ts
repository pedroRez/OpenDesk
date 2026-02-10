import Fastify from 'fastify';
import cors from '@fastify/cors';

import { config } from './config.js';
import { prismaPlugin } from './plugins/prisma.js';
import { authRoutes } from './routes/auth.js';
import { favoriteRoutes } from './routes/favorites.js';
import { hostRoutes } from './routes/hosts.js';
import { pcRoutes } from './routes/pcs.js';
import { sessionRoutes } from './routes/sessions.js';
import { softwareRoutes } from './routes/software.js';
import { streamRoutes } from './routes/stream.js';
import { walletRoutes } from './routes/wallet.js';
import { handleHostTimeouts } from './services/hostHeartbeat.js';
import { serverInstanceId } from './instance.js';
import { expirePromotedSlots, expireSessions } from './services/sessionService.js';

const app = Fastify({
  logger: {
    level: config.logLevel,
  },
  disableRequestLogging: true,
});

async function start() {
  try {
    await app.register(cors, {
      origin: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'x-user-id', 'x-dev-bypass-credits'],
    });

    await app.register(prismaPlugin);

    app.get('/health', async () => ({ status: 'ok' }));

    await app.register(authRoutes);
    await app.register(favoriteRoutes);
    await app.register(hostRoutes);
    await app.register(pcRoutes);
    await app.register(softwareRoutes);
    await app.register(sessionRoutes);
    await app.register(streamRoutes);
    await app.register(walletRoutes);

    app.addHook('onResponse', async (request, reply) => {
      const method = request.method.toUpperCase();
      if (config.httpLogIgnoreMethods.includes(method)) {
        return;
      }

      const status = reply.statusCode;
      const isDebug = config.logLevel.toLowerCase() === 'debug';
      if (!isDebug && status < 400) {
        return;
      }

      const payload = {
        method,
        url: request.url,
        status,
        durationMs: reply.getResponseTime(),
      };

      if (status >= 500) {
        app.log.error(payload, 'HTTP error');
      } else if (status >= 400) {
        app.log.warn(payload, 'HTTP error');
      } else {
        app.log.info(payload, 'HTTP request');
      }
    });

    setInterval(async () => {
      try {
        const expired = await expireSessions(app.prisma);
        if (expired > 0) {
          app.log.info({ expired }, 'Sessions expired');
        }
        const expiredPromotions = await expirePromotedSlots(app.prisma);
        if (expiredPromotions > 0) {
          app.log.info({ expiredPromotions }, 'Queue promotions expired');
        }
      } catch (error) {
        app.log.error({ error }, 'Failed to expire sessions');
      }
    }, config.sessionExpirationIntervalMs);

    setInterval(async () => {
      try {
        const hostsDown = await handleHostTimeouts(app.prisma);
        if (hostsDown > 0) {
          app.log.warn({ hostsDown }, 'Hosts marked as down');
        }
      } catch (error) {
        app.log.error({ error }, 'Failed to handle host timeouts');
      }
    }, config.hostHeartbeatCheckIntervalMs);

    app.log.info({ serverInstanceId }, 'Backend instance started');
    await app.listen({ port: config.port, host: '0.0.0.0' });
  } catch (error) {
    app.log.error({ error }, 'Failed to start server');
    process.exit(1);
  }
}

start();
