import Fastify from 'fastify';

import { config } from './config.js';
import { prismaPlugin } from './plugins/prisma.js';
import { authRoutes } from './routes/auth.js';
import { hostRoutes } from './routes/hosts.js';
import { pcRoutes } from './routes/pcs.js';
import { sessionRoutes } from './routes/sessions.js';
import { softwareRoutes } from './routes/software.js';
import { walletRoutes } from './routes/wallet.js';
import { expireSessions } from './services/sessionService.js';

const app = Fastify({ logger: true });

await app.register(prismaPlugin);

app.get('/health', async () => ({ status: 'ok' }));

await app.register(authRoutes);
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

app.listen({ port: config.port, host: '0.0.0.0' });
