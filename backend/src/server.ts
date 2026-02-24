import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';

import { getEnvBootstrapInfo } from './bootstrapEnv.js';
import { config } from './config.js';
import { prismaPlugin } from './plugins/prisma.js';
import { authRoutes } from './routes/auth.js';
import { favoriteRoutes } from './routes/favorites.js';
import { hostRoutes } from './routes/hosts.js';
import { pcRoutes } from './routes/pcs.js';
import { sessionRoutes } from './routes/sessions.js';
import { softwareRoutes } from './routes/software.js';
import { streamRoutes } from './routes/stream.js';
import { streamRelayRoutes } from './routes/streamRelay.js';
import { walletRoutes } from './routes/wallet.js';
import { handleHostTimeouts } from './services/hostHeartbeat.js';
import { serverInstanceId } from './instance.js';
import { expirePromotedSlots, expireSessions } from './services/sessionService.js';

function maskSecret(secret: string | undefined): string | null {
  const value = secret?.trim();
  if (!value) return null;
  if (value.length <= 4) return '*'.repeat(value.length);
  return `${value.slice(0, 2)}***${value.slice(-2)}`;
}

function summarizeDatabaseUrl(raw: string | undefined): {
  host: string | null;
  port: number | null;
  database: string | null;
} | null {
  const value = raw?.trim();
  if (!value) return null;
  try {
    const parsed = new URL(value);
    const database = parsed.pathname.replace(/^\/+/, '').trim() || null;
    const port = parsed.port.trim() ? Number(parsed.port) : null;
    return {
      host: parsed.hostname || null,
      port: Number.isFinite(port ?? NaN) ? port : null,
      database,
    };
  } catch {
    return null;
  }
}

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
    await app.register(websocket, {
      options: {
        maxPayload: 2 * 1024 * 1024,
      },
    });

    await app.register(prismaPlugin);

    app.get('/health', async () => ({ status: 'ok', serverInstanceId }));

    await app.register(authRoutes);
    await app.register(favoriteRoutes);
    await app.register(hostRoutes);
    await app.register(pcRoutes);
    await app.register(softwareRoutes);
    await app.register(sessionRoutes);
    await app.register(streamRoutes);
    await app.register(streamRelayRoutes);
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

    const envBootstrap = getEnvBootstrapInfo();
    app.log.info({
      envBootstrap,
      env: {
        PORT: config.port,
        DATABASE_URL: summarizeDatabaseUrl(process.env.DATABASE_URL),
        LOG_LEVEL: config.logLevel,
        LOG_HEARTBEAT: config.logHeartbeat,
        HEARTBEAT_LOG_SAMPLE_SECONDS: config.heartbeatLogSampleSeconds,
        HOST_HEARTBEAT_TIMEOUT_MS: config.hostHeartbeatTimeoutMs,
        HOST_HEARTBEAT_TIMEOUT_ACTIVE_MS: config.hostHeartbeatTimeoutActiveMs,
        HOST_HEARTBEAT_CHECK_INTERVAL_MS: config.hostHeartbeatCheckIntervalMs,
        HOST_OFFLINE_GRACE_SECONDS: config.hostOfflineGraceSeconds,
        HOST_OFFLINE_GRACE_ACTIVE_SECONDS: config.hostOfflineGraceActiveSeconds,
        JWT_SECRET_MASKED: maskSecret(process.env.JWT_SECRET),
      },
      serverInstanceId,
    }, 'Backend env snapshot');
    app.log.info({ serverInstanceId }, 'Backend instance started');
    await app.listen({ port: config.port, host: '0.0.0.0' });
  } catch (error) {
    app.log.error({ error }, 'Failed to start server');
    process.exit(1);
  }
}

start();
