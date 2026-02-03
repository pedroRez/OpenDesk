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
import { walletRoutes } from './routes/wallet.js';
import { handleHostTimeouts } from './services/hostHeartbeat.js';
import { expireSessions } from './services/sessionService.js';

const app = Fastify({ logger: true });

async function start() {
  try {
    await app.register(cors, {
      origin: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'x-user-id', 'x-dev-bypass-credits'],
    });

    await app.register(prismaPlugin);

    app.get('/health', async () => ({ status: 'ok' }));

    await app.register(authRoutes);
    await app.register(favoriteRoutes);
    await app.register(hostRoutes);
    await app.register(pcRoutes);
    await app.register(softwareRoutes);
    await app.register(sessionRoutes);
    await app.register(walletRoutes);

    setInterval(async () => {
      try {
        const expired = await expireSessions(app.prisma);
        if (expired > 0) {
          app.log.info({ expired }, 'Sessions expired');
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

    await app.listen({ port: config.port, host: '0.0.0.0' });
  } catch (error) {
    app.log.error({ error }, 'Failed to start server');
    process.exit(1);
  }
}

start();
