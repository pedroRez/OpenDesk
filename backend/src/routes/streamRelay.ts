import { SessionStatus } from '@prisma/client';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { deriveStreamId, streamIdsEqual } from '../utils/streamIdentity.js';

type RelayRole = 'host' | 'client';
type RelaySocket = any;
type RelayRawData = Buffer | ArrayBuffer | Uint8Array | Array<Buffer> | string;

type RelayRoomMetrics = {
  hostMessages: number;
  hostBytes: number;
  hostMessagesDroppedRate: number;
  hostMessagesDroppedNoClient: number;
  clientControlMessages: number;
  clientControlDroppedRate: number;
  clientControlDroppedNoHost: number;
  relayedMessages: number;
  relayedBytes: number;
};

type RelayRoom = {
  key: string;
  sessionId: string;
  streamId: string;
  createdAtMs: number;
  updatedAtMs: number;
  host: RelaySocket | null;
  clients: Set<RelaySocket>;
  metrics: RelayRoomMetrics;
};

type RelaySocketMeta = {
  roomKey: string;
  role: RelayRole;
  connectedAtMs: number;
  remoteIp: string | null;
  userId: string;
  sessionId: string;
  streamId: string;
  windowStartMs: number;
  windowBytes: number;
  windowMessages: number;
};

const STREAMABLE_STATES = new Set<SessionStatus>([SessionStatus.PENDING, SessionStatus.ACTIVE]);
const WS_CLOSE_POLICY_VIOLATION = 1008;
const WS_CLOSE_RATE_LIMIT = 1013;
const WS_CLOSE_INTERNAL = 1011;
const WS_OPEN = 1;
const CONNECTION_RATE_WINDOW_MS = 10_000;
const CONNECTION_RATE_MAX = 24;
const HOST_MAX_BYTES_PER_SEC = 25 * 1024 * 1024;
const CLIENT_MAX_MESSAGES_PER_SEC = 250;
const CLIENT_MAX_CONTROL_BYTES = 2048;

const rooms = new Map<string, RelayRoom>();
const socketMetadata = new WeakMap<RelaySocket, RelaySocketMeta>();
const connectionRateWindows = new Map<string, { startedAtMs: number; count: number }>();

const relayQuerySchema = z.object({
  role: z.enum(['host', 'client']),
  sessionId: z.string().uuid(),
  streamId: z.string().min(12).max(64),
  token: z.string().min(16).max(256),
  userId: z.string().uuid(),
});

function extractForwardedIp(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return null;
  const parts = raw
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  const first = parts.find((part) => part.toLowerCase() !== 'unknown');
  return first ?? null;
}

function getClientIp(request: FastifyRequest): string | null {
  return extractForwardedIp(request.headers['x-forwarded-for']) ?? request.ip ?? null;
}

function closeSocket(socket: RelaySocket, code: number, reason: string): void {
  try {
    socket.close(code, reason);
  } catch {
    // ignore
  }
}

function toBuffer(data: RelayRawData): Buffer {
  if (Buffer.isBuffer(data)) {
    return data;
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data);
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data);
  }
  return Buffer.from(data);
}

function getRoomKey(sessionId: string, streamId: string): string {
  return `${sessionId}:${streamId.toLowerCase()}`;
}

function getOrCreateRoom(sessionId: string, streamId: string): RelayRoom {
  const key = getRoomKey(sessionId, streamId);
  const existing = rooms.get(key);
  if (existing) return existing;
  const room: RelayRoom = {
    key,
    sessionId,
    streamId,
    createdAtMs: Date.now(),
    updatedAtMs: Date.now(),
    host: null,
    clients: new Set<RelaySocket>(),
    metrics: {
      hostMessages: 0,
      hostBytes: 0,
      hostMessagesDroppedRate: 0,
      hostMessagesDroppedNoClient: 0,
      clientControlMessages: 0,
      clientControlDroppedRate: 0,
      clientControlDroppedNoHost: 0,
      relayedMessages: 0,
      relayedBytes: 0,
    },
  };
  rooms.set(key, room);
  return room;
}

function cleanupRoomIfIdle(fastify: FastifyInstance, room: RelayRoom): void {
  const isEmpty = room.host === null && room.clients.size === 0;
  if (!isEmpty) return;
  rooms.delete(room.key);
  fastify.log.info(
    {
      event: 'relay_room_closed',
      sessionId: room.sessionId,
      streamId: room.streamId,
      lifetimeMs: Date.now() - room.createdAtMs,
      metrics: room.metrics,
    },
    'Relay room removed',
  );
}

function allowConnectionAttempt(key: string): boolean {
  const now = Date.now();
  if (connectionRateWindows.size > 2000) {
    for (const [entryKey, entry] of connectionRateWindows.entries()) {
      if (now - entry.startedAtMs > CONNECTION_RATE_WINDOW_MS * 3) {
        connectionRateWindows.delete(entryKey);
      }
    }
  }
  const current = connectionRateWindows.get(key);
  if (!current || now - current.startedAtMs >= CONNECTION_RATE_WINDOW_MS) {
    connectionRateWindows.set(key, { startedAtMs: now, count: 1 });
    return true;
  }

  current.count += 1;
  if (current.count > CONNECTION_RATE_MAX) {
    return false;
  }
  return true;
}

function rotateSocketRateWindow(meta: RelaySocketMeta, now: number): void {
  if (now - meta.windowStartMs < 1000) return;
  meta.windowStartMs = now;
  meta.windowBytes = 0;
  meta.windowMessages = 0;
}

function checkSocketRateLimit(meta: RelaySocketMeta, bytes: number): { ok: boolean; reason: string } {
  const now = Date.now();
  rotateSocketRateWindow(meta, now);
  meta.windowBytes += bytes;
  meta.windowMessages += 1;

  if (meta.role === 'host' && meta.windowBytes > HOST_MAX_BYTES_PER_SEC) {
    return { ok: false, reason: 'host_rate_limit' };
  }
  if (meta.role === 'client' && meta.windowMessages > CLIENT_MAX_MESSAGES_PER_SEC) {
    return { ok: false, reason: 'client_rate_limit' };
  }
  return { ok: true, reason: '' };
}

export async function streamRelayRoutes(fastify: FastifyInstance) {
  fastify.get('/stream/relay', { websocket: true }, async (socket, request) => {
    const parseResult = relayQuerySchema.safeParse(request.query);
    if (!parseResult.success) {
      closeSocket(socket, WS_CLOSE_POLICY_VIOLATION, 'invalid_query');
      return;
    }
    const query = parseResult.data;
    const remoteIp = getClientIp(request);
    const connectionRateKey = `${remoteIp ?? 'unknown'}:${query.userId}:${query.sessionId}`;
    if (!allowConnectionAttempt(connectionRateKey)) {
      fastify.log.warn(
        {
          event: 'relay_connect_denied_rate',
          remoteIp,
          userId: query.userId,
          sessionId: query.sessionId,
        },
        'Relay websocket connection blocked by rate limiter',
      );
      closeSocket(socket, WS_CLOSE_RATE_LIMIT, 'rate_limited');
      return;
    }

    try {
      const tokenRecord = await fastify.prisma.streamConnectToken.findUnique({
        where: { token: query.token },
        select: {
          token: true,
          userId: true,
          pcId: true,
          expiresAt: true,
        },
      });

      if (!tokenRecord) {
        closeSocket(socket, WS_CLOSE_POLICY_VIOLATION, 'invalid_token');
        return;
      }
      if (tokenRecord.expiresAt.getTime() <= Date.now()) {
        closeSocket(socket, WS_CLOSE_POLICY_VIOLATION, 'expired_token');
        return;
      }

      const session = await fastify.prisma.session.findUnique({
        where: { id: query.sessionId },
        select: {
          id: true,
          status: true,
          pcId: true,
          clientUserId: true,
          pc: {
            select: {
              host: {
                select: {
                  userId: true,
                },
              },
            },
          },
        },
      });
      if (!session || !STREAMABLE_STATES.has(session.status)) {
        closeSocket(socket, WS_CLOSE_POLICY_VIOLATION, 'session_not_streamable');
        return;
      }
      if (tokenRecord.pcId !== session.pcId || tokenRecord.userId !== session.clientUserId) {
        closeSocket(socket, WS_CLOSE_POLICY_VIOLATION, 'token_session_mismatch');
        return;
      }

      const expectedStreamId = deriveStreamId(tokenRecord.token);
      if (!streamIdsEqual(expectedStreamId, query.streamId)) {
        closeSocket(socket, WS_CLOSE_POLICY_VIOLATION, 'stream_mismatch');
        return;
      }

      if (query.role === 'client' && query.userId !== session.clientUserId) {
        closeSocket(socket, WS_CLOSE_POLICY_VIOLATION, 'client_forbidden');
        return;
      }
      if (query.role === 'host' && query.userId !== session.pc.host.userId) {
        closeSocket(socket, WS_CLOSE_POLICY_VIOLATION, 'host_forbidden');
        return;
      }

      const room = getOrCreateRoom(session.id, expectedStreamId);
      const connectedAtMs = Date.now();
      const metadata: RelaySocketMeta = {
        roomKey: room.key,
        role: query.role,
        connectedAtMs,
        remoteIp,
        userId: query.userId,
        sessionId: session.id,
        streamId: expectedStreamId,
        windowStartMs: connectedAtMs,
        windowBytes: 0,
        windowMessages: 0,
      };
      socketMetadata.set(socket, metadata);

      if (query.role === 'host') {
        if (room.host && room.host.readyState === WS_OPEN) {
          closeSocket(room.host, WS_CLOSE_POLICY_VIOLATION, 'host_replaced');
        }
        room.host = socket;
      } else {
        room.clients.add(socket);
      }
      room.updatedAtMs = Date.now();

      fastify.log.info(
        {
          event: 'relay_connect',
          role: query.role,
          sessionId: session.id,
          streamId: expectedStreamId,
          userId: query.userId,
          remoteIp,
          clients: room.clients.size,
          hasHost: Boolean(room.host && room.host.readyState === WS_OPEN),
        },
        'Relay websocket connected',
      );

      socket.send(
        JSON.stringify({
          type: 'relay.welcome',
          role: query.role,
          sessionId: session.id,
          streamId: expectedStreamId,
          connectedAt: new Date(connectedAtMs).toISOString(),
        }),
      );

      socket.on('message', (raw: RelayRawData, isBinary: boolean) => {
        const meta = socketMetadata.get(socket);
        if (!meta) return;
        const activeRoom = rooms.get(meta.roomKey);
        if (!activeRoom) return;

        const payload = toBuffer(raw);
        const rateCheck = checkSocketRateLimit(meta, payload.length);
        if (!rateCheck.ok) {
          if (meta.role === 'host') {
            activeRoom.metrics.hostMessagesDroppedRate += 1;
          } else {
            activeRoom.metrics.clientControlDroppedRate += 1;
          }
          closeSocket(socket, WS_CLOSE_RATE_LIMIT, rateCheck.reason);
          return;
        }

        if (meta.role === 'host') {
          if (!isBinary) {
            return;
          }
          activeRoom.metrics.hostMessages += 1;
          activeRoom.metrics.hostBytes += payload.length;

          if (activeRoom.clients.size === 0) {
            activeRoom.metrics.hostMessagesDroppedNoClient += 1;
            return;
          }

          let relayedCount = 0;
          for (const clientSocket of activeRoom.clients) {
            if (clientSocket.readyState !== WS_OPEN) {
              continue;
            }
            try {
              clientSocket.send(payload, { binary: true });
              relayedCount += 1;
            } catch {
              // keep room alive; socket close handler will clean this up
            }
          }

          if (relayedCount > 0) {
            activeRoom.metrics.relayedMessages += relayedCount;
            activeRoom.metrics.relayedBytes += payload.length * relayedCount;
            activeRoom.updatedAtMs = Date.now();
          }
          return;
        }

        if (isBinary || payload.length === 0 || payload.length > CLIENT_MAX_CONTROL_BYTES) {
          activeRoom.metrics.clientControlDroppedRate += 1;
          return;
        }

        activeRoom.metrics.clientControlMessages += 1;
        if (!activeRoom.host || activeRoom.host.readyState !== WS_OPEN) {
          activeRoom.metrics.clientControlDroppedNoHost += 1;
          return;
        }

        try {
          activeRoom.host.send(payload.toString('utf8'), { binary: false });
          activeRoom.updatedAtMs = Date.now();
        } catch {
          activeRoom.metrics.clientControlDroppedNoHost += 1;
        }
      });

      socket.on('close', (code: number, reasonBuffer: Buffer) => {
        const reason = reasonBuffer.toString('utf8');
        const meta = socketMetadata.get(socket);
        if (!meta) return;
        const activeRoom = rooms.get(meta.roomKey);
        if (!activeRoom) return;

        if (meta.role === 'host' && activeRoom.host === socket) {
          activeRoom.host = null;
        }
        if (meta.role === 'client') {
          activeRoom.clients.delete(socket);
        }
        activeRoom.updatedAtMs = Date.now();

        fastify.log.info(
          {
            event: 'relay_disconnect',
            role: meta.role,
            sessionId: meta.sessionId,
            streamId: meta.streamId,
            userId: meta.userId,
            remoteIp: meta.remoteIp,
            connectedMs: Date.now() - meta.connectedAtMs,
            code,
            reason: reason || null,
            clients: activeRoom.clients.size,
            hasHost: Boolean(activeRoom.host && activeRoom.host.readyState === WS_OPEN),
          },
          'Relay websocket disconnected',
        );

        cleanupRoomIfIdle(fastify, activeRoom);
      });

      socket.on('error', (error: Error) => {
        fastify.log.warn(
          {
            event: 'relay_socket_error',
            role: query.role,
            sessionId: query.sessionId,
            streamId: query.streamId,
            userId: query.userId,
            remoteIp,
            message: error.message,
          },
          'Relay websocket error',
        );
        closeSocket(socket, WS_CLOSE_INTERNAL, 'socket_error');
      });
    } catch (error) {
      fastify.log.error(
        {
          event: 'relay_connect_internal_error',
          remoteIp,
          role: query.role,
          sessionId: query.sessionId,
          streamId: query.streamId,
          userId: query.userId,
          message: error instanceof Error ? error.message : String(error ?? 'erro desconhecido'),
        },
        'Relay websocket handshake failed',
      );
      closeSocket(socket, WS_CLOSE_INTERNAL, 'internal_error');
    }
  });
}
