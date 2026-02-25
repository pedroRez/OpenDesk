import { SessionStatus } from '@prisma/client';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { deriveStreamId, streamIdsEqual } from '../utils/streamIdentity.js';

type RelayRole = 'host' | 'client';
type RelaySocket = any;
type RelayRawData = Buffer | ArrayBuffer | Uint8Array | Array<Buffer> | string;
type RelayFeedbackType =
  | 'keyframe_request'
  | 'network_report'
  | 'reconnect'
  | 'request_keyframe'
  | 'report_stats';
type RelayInputEventType = 'mouse_move' | 'mouse_button' | 'mouse_wheel' | 'key' | 'disconnect_hotkey';
type RelayHostControlType = 'stream_pong';

type RelayFeedbackMessage = {
  type: RelayFeedbackType;
  token: string;
  sessionId: string;
  streamId: string;
  lossPct?: number;
  jitterMs?: number;
  freezeMs?: number;
  requestedBitrateKbps?: number;
  reason?: string;
  sentAtUs?: number;
  fpsDecode?: number;
  rttMs?: number;
  dropRatePct?: number;
  bufferLevel?: number;
  bitrateKbps?: number;
  status?: string;
};

type RelayPingMessage = {
  type: 'stream_ping';
  token: string;
  sessionId: string;
  streamId: string;
  pingId: number;
  sentAtUs: number;
};

type RelayInputEvent =
  | { type: 'mouse_move'; seq: number; tsUs: number; dx: number; dy: number }
  | { type: 'mouse_button'; seq: number; tsUs: number; button: number; down: boolean }
  | { type: 'mouse_wheel'; seq: number; tsUs: number; deltaX: number; deltaY: number }
  | {
      type: 'key';
      seq: number;
      tsUs: number;
      scancode: string;
      down: boolean;
      ctrl?: boolean;
      alt?: boolean;
      shift?: boolean;
      meta?: boolean;
    }
  | { type: 'disconnect_hotkey'; seq: number; tsUs: number };

type RelayInputEnvelope = {
  type: 'input_event';
  version: number;
  token: string;
  sessionId: string;
  streamId: string;
  event: RelayInputEvent;
};

type RelayPongMessage = {
  type: 'stream_pong';
  sessionId: string;
  streamId: string;
  pingId: number;
  sentAtUs?: number;
  receivedAtUs?: number;
  hostTsUs?: number;
};

type RelayClientTextMessage =
  | { kind: 'feedback'; payload: RelayFeedbackMessage }
  | { kind: 'stream_ping'; payload: RelayPingMessage }
  | { kind: 'input_event'; payload: RelayInputEnvelope };

type RelayHostTextMessage = { kind: 'stream_pong'; payload: RelayPongMessage };

type RelayRoomMetrics = {
  hostMessages: number;
  hostBytes: number;
  hostMessagesDroppedRate: number;
  hostMessagesDroppedNoClient: number;
  hostControlMessages: number;
  hostControlDroppedInvalid: number;
  hostPongsForwarded: number;
  clientControlMessages: number;
  clientControlDroppedRate: number;
  clientControlDroppedNoHost: number;
  clientControlDroppedInvalid: number;
  clientControlDroppedNotActive: number;
  clientFeedbackForwarded: number;
  clientPingsForwarded: number;
  clientInputForwarded: number;
  relayedMessages: number;
  relayedBytes: number;
};

type RelayRoom = {
  key: string;
  sessionId: string;
  streamId: string;
  createdAtMs: number;
  updatedAtMs: number;
  sessionStatus: SessionStatus;
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
  token: string;
  windowStartMs: number;
  windowBytes: number;
  windowMessages: number;
};

type RelayRoomCloseContext = {
  reason: string;
  triggerRole?: RelayRole;
  disconnectCode?: number;
  disconnectReason?: string | null;
};

const STREAMABLE_STATES = new Set<SessionStatus>([SessionStatus.PENDING, SessionStatus.ACTIVE]);
const WS_CLOSE_POLICY_VIOLATION = 1008;
const WS_CLOSE_RATE_LIMIT = 1013;
const WS_CLOSE_INTERNAL = 1011;
const WS_OPEN = 1;
const CONNECTION_RATE_WINDOW_MS = 10_000;
const CONNECTION_RATE_MAX = 24;
const HOST_MAX_BYTES_PER_SEC = 25 * 1024 * 1024;
const HOST_MAX_CONTROL_BYTES = 1024;
const CLIENT_MAX_MESSAGES_PER_SEC = 700;
const CLIENT_MAX_CONTROL_BYTES = 2048;
const RELAY_ROOM_SWEEP_INTERVAL_MS = 3000;
const INPUT_MAX_MOUSE_DELTA = 3000;
const INPUT_MAX_WHEEL_DELTA = 2400;
const INPUT_MAX_SCANCODE_LEN = 64;
const INPUT_MAX_MOUSE_BUTTON = 5;
const FEEDBACK_TYPES: RelayFeedbackType[] = [
  'keyframe_request',
  'network_report',
  'reconnect',
  'request_keyframe',
  'report_stats',
];
const INPUT_EVENT_TYPES: RelayInputEventType[] = ['mouse_move', 'mouse_button', 'mouse_wheel', 'key', 'disconnect_hotkey'];
const HOST_CONTROL_TYPES: RelayHostControlType[] = ['stream_pong'];

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

function getOrCreateRoom(sessionId: string, streamId: string, sessionStatus: SessionStatus): RelayRoom {
  const key = getRoomKey(sessionId, streamId);
  const existing = rooms.get(key);
  if (existing) {
    existing.sessionStatus = sessionStatus;
    return existing;
  }
  const room: RelayRoom = {
    key,
    sessionId,
    streamId,
    createdAtMs: Date.now(),
    updatedAtMs: Date.now(),
    sessionStatus,
    host: null,
    clients: new Set<RelaySocket>(),
    metrics: {
      hostMessages: 0,
      hostBytes: 0,
      hostMessagesDroppedRate: 0,
      hostMessagesDroppedNoClient: 0,
      hostControlMessages: 0,
      hostControlDroppedInvalid: 0,
      hostPongsForwarded: 0,
      clientControlMessages: 0,
      clientControlDroppedRate: 0,
      clientControlDroppedNoHost: 0,
      clientControlDroppedInvalid: 0,
      clientControlDroppedNotActive: 0,
      clientFeedbackForwarded: 0,
      clientPingsForwarded: 0,
      clientInputForwarded: 0,
      relayedMessages: 0,
      relayedBytes: 0,
    },
  };
  rooms.set(key, room);
  return room;
}

function cleanupRoomIfIdle(
  fastify: FastifyInstance,
  room: RelayRoom,
  closeContext?: RelayRoomCloseContext,
): void {
  const isEmpty = room.host === null && room.clients.size === 0;
  if (!isEmpty) return;
  rooms.delete(room.key);
  fastify.log.info(
    {
      event: 'relay_room_closed',
      closeReason: closeContext?.reason ?? 'no_host_no_client',
      triggerRole: closeContext?.triggerRole ?? null,
      disconnectCode: closeContext?.disconnectCode ?? null,
      disconnectReason: closeContext?.disconnectReason ?? null,
      sessionId: room.sessionId,
      streamId: room.streamId,
      lifetimeMs: Date.now() - room.createdAtMs,
      roomStats: buildRoomSnapshot(room),
      metrics: room.metrics,
    },
    'Relay room removed',
  );
}

function buildRoomSnapshot(room: RelayRoom): {
  connectedClients: number;
  hasHost: boolean;
  hostBytesPerSec: number;
  hostMsgsPerSec: number;
  clientMsgsPerSec: number;
} {
  const elapsedSec = Math.max(1, (Date.now() - room.createdAtMs) / 1000);
  return {
    connectedClients: room.clients.size,
    hasHost: Boolean(room.host && room.host.readyState === WS_OPEN),
    hostBytesPerSec: Number((room.metrics.hostBytes / elapsedSec).toFixed(2)),
    hostMsgsPerSec: Number((room.metrics.hostMessages / elapsedSec).toFixed(2)),
    clientMsgsPerSec: Number((room.metrics.clientControlMessages / elapsedSec).toFixed(2)),
  };
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

function parseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > CLIENT_MAX_CONTROL_BYTES) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  return parsed as Record<string, unknown>;
}

function parseRelayInputEvent(raw: unknown): RelayInputEvent | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const input = raw as Record<string, unknown>;
  const typeRaw = typeof input.type === 'string' ? input.type.trim().toLowerCase() : '';
  if (!INPUT_EVENT_TYPES.includes(typeRaw as RelayInputEventType)) return null;
  const seq = typeof input.seq === 'number' ? Math.max(0, Math.trunc(input.seq)) : 0;
  const tsUs = typeof input.tsUs === 'number' ? Math.max(0, Math.trunc(input.tsUs)) : 0;

  if (typeRaw === 'mouse_move') {
    if (typeof input.dx !== 'number' || typeof input.dy !== 'number') return null;
    const dx = Math.trunc(input.dx);
    const dy = Math.trunc(input.dy);
    if (Math.abs(dx) > INPUT_MAX_MOUSE_DELTA || Math.abs(dy) > INPUT_MAX_MOUSE_DELTA) return null;
    return { type: 'mouse_move', seq, tsUs, dx, dy };
  }
  if (typeRaw === 'mouse_button') {
    if (typeof input.button !== 'number') return null;
    const button = Math.max(0, Math.trunc(input.button));
    if (button > INPUT_MAX_MOUSE_BUTTON) return null;
    const down = Boolean(input.down);
    return { type: 'mouse_button', seq, tsUs, button, down };
  }
  if (typeRaw === 'mouse_wheel') {
    if (typeof input.deltaX !== 'number' || typeof input.deltaY !== 'number') return null;
    const deltaX = Math.trunc(input.deltaX);
    const deltaY = Math.trunc(input.deltaY);
    if (Math.abs(deltaX) > INPUT_MAX_WHEEL_DELTA || Math.abs(deltaY) > INPUT_MAX_WHEEL_DELTA) return null;
    return { type: 'mouse_wheel', seq, tsUs, deltaX, deltaY };
  }
  if (typeRaw === 'key') {
    const scancodeValue = typeof input.scancode === 'string'
      ? input.scancode.trim()
      : typeof input.code === 'string'
        ? input.code.trim()
        : '';
    if (!scancodeValue || scancodeValue.length > INPUT_MAX_SCANCODE_LEN) return null;
    const down = Boolean(input.down);
    return {
      type: 'key',
      seq,
      tsUs,
      scancode: scancodeValue,
      down,
      ctrl: input.ctrl === undefined ? undefined : Boolean(input.ctrl),
      alt: input.alt === undefined ? undefined : Boolean(input.alt),
      shift: input.shift === undefined ? undefined : Boolean(input.shift),
      meta: input.meta === undefined ? undefined : Boolean(input.meta),
    };
  }
  return { type: 'disconnect_hotkey', seq, tsUs };
}

function parseHostTextMessage(text: string): RelayHostTextMessage | null {
  const input = parseJsonObject(text);
  if (!input) return null;
  const typeRaw = typeof input.type === 'string' ? input.type.trim().toLowerCase() : '';
  if (!HOST_CONTROL_TYPES.includes(typeRaw as RelayHostControlType)) return null;

  const sessionId = typeof input.sessionId === 'string' ? input.sessionId : '';
  const streamId = typeof input.streamId === 'string' ? input.streamId : '';
  if (!sessionId || !streamId) return null;
  if (typeof input.pingId !== 'number' || !Number.isFinite(input.pingId)) return null;

  return {
    kind: 'stream_pong',
    payload: {
      type: 'stream_pong',
      sessionId,
      streamId,
      pingId: Math.max(0, Math.trunc(input.pingId)),
      sentAtUs: typeof input.sentAtUs === 'number' ? Math.max(0, Math.trunc(input.sentAtUs)) : undefined,
      receivedAtUs:
        typeof input.receivedAtUs === 'number' ? Math.max(0, Math.trunc(input.receivedAtUs)) : undefined,
      hostTsUs: typeof input.hostTsUs === 'number' ? Math.max(0, Math.trunc(input.hostTsUs)) : undefined,
    },
  };
}

function parseClientTextMessage(text: string): RelayClientTextMessage | null {
  const input = parseJsonObject(text);
  if (!input) return null;

  const typeRaw = typeof input.type === 'string' ? input.type.trim().toLowerCase() : '';
  if (typeRaw === 'stream_ping') {
    const token = typeof input.token === 'string' ? input.token : '';
    const sessionId = typeof input.sessionId === 'string' ? input.sessionId : '';
    const streamId = typeof input.streamId === 'string' ? input.streamId : '';
    const pingId = typeof input.pingId === 'number' ? Math.max(0, Math.trunc(input.pingId)) : -1;
    const sentAtUs = typeof input.sentAtUs === 'number' ? Math.max(0, Math.trunc(input.sentAtUs)) : -1;
    if (!token || !sessionId || !streamId || pingId < 0 || sentAtUs < 0) return null;
    return {
      kind: 'stream_ping',
      payload: {
        type: 'stream_ping',
        token,
        sessionId,
        streamId,
        pingId,
        sentAtUs,
      },
    };
  }

  if (FEEDBACK_TYPES.includes(typeRaw as RelayFeedbackType)) {
    const token = typeof input.token === 'string' ? input.token : '';
    const sessionId = typeof input.sessionId === 'string' ? input.sessionId : '';
    const streamId = typeof input.streamId === 'string' ? input.streamId : '';
    if (!token || !sessionId || !streamId) return null;
    return {
      kind: 'feedback',
      payload: {
        type: typeRaw as RelayFeedbackType,
        token,
        sessionId,
        streamId,
        lossPct: typeof input.lossPct === 'number' ? input.lossPct : undefined,
        jitterMs: typeof input.jitterMs === 'number' ? input.jitterMs : undefined,
        freezeMs: typeof input.freezeMs === 'number' ? input.freezeMs : undefined,
        requestedBitrateKbps:
          typeof input.requestedBitrateKbps === 'number' ? input.requestedBitrateKbps : undefined,
        reason: typeof input.reason === 'string' ? input.reason : undefined,
        sentAtUs: typeof input.sentAtUs === 'number' ? input.sentAtUs : undefined,
        fpsDecode: typeof input.fpsDecode === 'number' ? input.fpsDecode : undefined,
        rttMs: typeof input.rttMs === 'number' ? input.rttMs : undefined,
        dropRatePct: typeof input.dropRatePct === 'number' ? input.dropRatePct : undefined,
        bufferLevel: typeof input.bufferLevel === 'number' ? input.bufferLevel : undefined,
        bitrateKbps: typeof input.bitrateKbps === 'number' ? input.bitrateKbps : undefined,
        status: typeof input.status === 'string' ? input.status : undefined,
      },
    };
  }

  if (typeRaw !== 'input_event') return null;

  const token = typeof input.token === 'string' ? input.token : '';
  const sessionId = typeof input.sessionId === 'string' ? input.sessionId : '';
  const streamId = typeof input.streamId === 'string' ? input.streamId : '';
  if (!token || !sessionId || !streamId) return null;
  const event = parseRelayInputEvent(input.event);
  if (!event) return null;

  return {
    kind: 'input_event',
    payload: {
      type: 'input_event',
      version: typeof input.version === 'number' ? Math.max(1, Math.trunc(input.version)) : 1,
      token,
      sessionId,
      streamId,
      event,
    },
  };
}

function closeRoomSockets(room: RelayRoom, code: number, reason: string): void {
  if (room.host) {
    closeSocket(room.host, code, reason);
  }
  for (const client of room.clients) {
    closeSocket(client, code, reason);
  }
}

export async function streamRelayRoutes(fastify: FastifyInstance) {
  const sessionSweep = setInterval(() => {
    void (async () => {
      if (rooms.size === 0) return;
      const sessionIds = Array.from(new Set(Array.from(rooms.values()).map((room) => room.sessionId)));
      const sessions = await fastify.prisma.session.findMany({
        where: { id: { in: sessionIds } },
        select: { id: true, status: true },
      });
      const statusBySessionId = new Map<string, SessionStatus>(sessions.map((session) => [session.id, session.status]));

      for (const room of Array.from(rooms.values())) {
        const status = statusBySessionId.get(room.sessionId);
        if (!status || !STREAMABLE_STATES.has(status)) {
          closeRoomSockets(room, WS_CLOSE_POLICY_VIOLATION, 'session_closed');
          rooms.delete(room.key);
          fastify.log.info(
            {
              event: 'relay_room_closed_session',
              sessionId: room.sessionId,
              streamId: room.streamId,
              status: status ?? null,
              roomStats: buildRoomSnapshot(room),
            },
            'Relay room closed by session sweep',
          );
          continue;
        }
        room.sessionStatus = status;
      }
    })().catch((error) => {
      fastify.log.warn(
        {
          event: 'relay_room_sweep_error',
          message: error instanceof Error ? error.message : String(error ?? 'erro desconhecido'),
        },
        'Relay room sweep failed',
      );
    });
  }, RELAY_ROOM_SWEEP_INTERVAL_MS);

  fastify.addHook('onClose', async () => {
    clearInterval(sessionSweep);
    for (const room of rooms.values()) {
      closeRoomSockets(room, WS_CLOSE_INTERNAL, 'relay_shutdown');
    }
    rooms.clear();
  });

  fastify.get('/stream/relay', { websocket: true }, async (socket, request) => {
    const remoteIp = getClientIp(request);
    const rawQuery =
      request.query && typeof request.query === 'object' && !Array.isArray(request.query)
        ? (request.query as Record<string, unknown>)
        : null;
    const baseOpenLog = {
      remoteIp,
      role: typeof rawQuery?.role === 'string' ? rawQuery.role : null,
      sessionId: typeof rawQuery?.sessionId === 'string' ? rawQuery.sessionId : null,
      streamId: typeof rawQuery?.streamId === 'string' ? rawQuery.streamId : null,
      userId: typeof rawQuery?.userId === 'string' ? rawQuery.userId : null,
      tokenPresent: typeof rawQuery?.token === 'string' && rawQuery.token.trim().length > 0,
      hostHeader: request.headers.host ?? null,
      forwardedHost: request.headers['x-forwarded-host'] ?? null,
      forwardedProto: request.headers['x-forwarded-proto'] ?? null,
      userAgent: request.headers['user-agent'] ?? null,
    };
    fastify.log.info(
      {
        event: 'relay_socket_open',
        ...baseOpenLog,
      },
      'Relay websocket opening',
    );

    const rejectSocket = (
      reason: string,
      code: number = WS_CLOSE_POLICY_VIOLATION,
      extra: Record<string, unknown> = {},
    ): void => {
      fastify.log.warn(
        {
          event: 'relay_reject',
          reason,
          code,
          ...baseOpenLog,
          ...extra,
        },
        'Relay websocket rejected',
      );
      closeSocket(socket, code, reason);
    };

    const parseResult = relayQuerySchema.safeParse(request.query);
    if (!parseResult.success) {
      rejectSocket('invalid_query', WS_CLOSE_POLICY_VIOLATION, {
        issues: parseResult.error.issues.slice(0, 4).map((issue) => ({
          path: issue.path.join('.'),
          code: issue.code,
        })),
      });
      return;
    }
    const query = parseResult.data;
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
      rejectSocket('rate_limited', WS_CLOSE_RATE_LIMIT);
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
        rejectSocket('invalid_token');
        return;
      }
      if (tokenRecord.expiresAt.getTime() <= Date.now()) {
        rejectSocket('expired_token');
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
        rejectSocket('session_not_streamable');
        return;
      }
      if (tokenRecord.pcId !== session.pcId || tokenRecord.userId !== session.clientUserId) {
        rejectSocket('token_session_mismatch', WS_CLOSE_POLICY_VIOLATION, {
          tokenPcId: tokenRecord.pcId,
          sessionPcId: session.pcId,
          tokenUserId: tokenRecord.userId,
          sessionClientUserId: session.clientUserId,
        });
        return;
      }

      const expectedStreamId = deriveStreamId(tokenRecord.token);
      if (!streamIdsEqual(expectedStreamId, query.streamId)) {
        rejectSocket('stream_mismatch', WS_CLOSE_POLICY_VIOLATION, {
          expectedStreamId,
          providedStreamId: query.streamId,
        });
        return;
      }

      if (query.role === 'client' && query.userId !== session.clientUserId) {
        rejectSocket('client_forbidden', WS_CLOSE_POLICY_VIOLATION, {
          expectedUserId: session.clientUserId,
          providedUserId: query.userId,
        });
        return;
      }
      if (query.role === 'host' && query.userId !== session.pc.host.userId) {
        rejectSocket('host_forbidden', WS_CLOSE_POLICY_VIOLATION, {
          expectedUserId: session.pc.host.userId,
          providedUserId: query.userId,
        });
        return;
      }

      const room = getOrCreateRoom(session.id, expectedStreamId, session.status);
      const connectedAtMs = Date.now();
      const metadata: RelaySocketMeta = {
        roomKey: room.key,
        role: query.role,
        connectedAtMs,
        remoteIp,
        userId: query.userId,
        sessionId: session.id,
        streamId: expectedStreamId,
        token: tokenRecord.token,
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
          roomStats: buildRoomSnapshot(room),
        },
        'Relay websocket connected',
      );
      if (query.role === 'host') {
        fastify.log.info(
          {
            event: 'relay_connect_host',
            sessionId: session.id,
            streamId: expectedStreamId,
            userId: query.userId,
            remoteIp,
            clients: room.clients.size,
            hasHost: Boolean(room.host && room.host.readyState === WS_OPEN),
            roomStats: buildRoomSnapshot(room),
          },
          'Relay host connected',
        );
      }

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
        // Token expiry is enforced at handshake time. Keeping active sockets alive
        // avoids mid-session drops when a stream runs longer than token TTL.

        const payload = toBuffer(raw);
        const rateCheck = checkSocketRateLimit(meta, payload.length);
        if (!rateCheck.ok) {
          if (meta.role === 'host') {
            activeRoom.metrics.hostMessagesDroppedRate += 1;
          } else {
            activeRoom.metrics.clientControlDroppedRate += 1;
          }
          fastify.log.warn(
            {
              event: 'relay_socket_rate_limited',
              role: meta.role,
              sessionId: meta.sessionId,
              streamId: meta.streamId,
              userId: meta.userId,
              remoteIp: meta.remoteIp,
              reason: rateCheck.reason,
              roomStats: buildRoomSnapshot(activeRoom),
            },
            'Relay websocket rate limit triggered',
          );
          closeSocket(socket, WS_CLOSE_RATE_LIMIT, rateCheck.reason);
          return;
        }

        if (meta.role === 'host') {
          if (isBinary) {
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

          if (payload.length === 0 || payload.length > HOST_MAX_CONTROL_BYTES) {
            activeRoom.metrics.hostControlDroppedInvalid += 1;
            return;
          }
          const parsedHostMessage = parseHostTextMessage(payload.toString('utf8'));
          if (!parsedHostMessage) {
            activeRoom.metrics.hostControlDroppedInvalid += 1;
            return;
          }
          const hostScopeMatches =
            parsedHostMessage.payload.sessionId === meta.sessionId &&
            streamIdsEqual(parsedHostMessage.payload.streamId, meta.streamId);
          if (!hostScopeMatches) {
            activeRoom.metrics.hostControlDroppedInvalid += 1;
            return;
          }

          if (activeRoom.clients.size === 0) {
            activeRoom.metrics.hostMessagesDroppedNoClient += 1;
            return;
          }

          let relayedCount = 0;
          const encoded = JSON.stringify(parsedHostMessage.payload);
          for (const clientSocket of activeRoom.clients) {
            if (clientSocket.readyState !== WS_OPEN) continue;
            try {
              clientSocket.send(encoded, { binary: false });
              relayedCount += 1;
            } catch {
              // ignore and let close handler cleanup
            }
          }
          if (relayedCount > 0) {
            activeRoom.metrics.hostControlMessages += 1;
            if (parsedHostMessage.kind === 'stream_pong') {
              activeRoom.metrics.hostPongsForwarded += relayedCount;
            }
            activeRoom.updatedAtMs = Date.now();
          }
          return;
        }

        if (isBinary || payload.length === 0 || payload.length > CLIENT_MAX_CONTROL_BYTES) {
          activeRoom.metrics.clientControlDroppedRate += 1;
          return;
        }

        const parsedMessage = parseClientTextMessage(payload.toString('utf8'));
        if (!parsedMessage) {
          activeRoom.metrics.clientControlDroppedInvalid += 1;
          return;
        }

        const matchesScope =
          parsedMessage.payload.token === meta.token &&
          parsedMessage.payload.sessionId === meta.sessionId &&
          streamIdsEqual(parsedMessage.payload.streamId, meta.streamId);
        if (!matchesScope) {
          activeRoom.metrics.clientControlDroppedInvalid += 1;
          return;
        }

        activeRoom.metrics.clientControlMessages += 1;
        if (!activeRoom.host || activeRoom.host.readyState !== WS_OPEN) {
          activeRoom.metrics.clientControlDroppedNoHost += 1;
          return;
        }
        if (parsedMessage.kind === 'input_event' && activeRoom.sessionStatus !== SessionStatus.ACTIVE) {
          activeRoom.metrics.clientControlDroppedNotActive += 1;
          return;
        }

        try {
          activeRoom.host.send(JSON.stringify(parsedMessage.payload), { binary: false });
          if (parsedMessage.kind === 'input_event') activeRoom.metrics.clientInputForwarded += 1;
          if (parsedMessage.kind === 'feedback') activeRoom.metrics.clientFeedbackForwarded += 1;
          if (parsedMessage.kind === 'stream_ping') activeRoom.metrics.clientPingsForwarded += 1;
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
            roomStats: buildRoomSnapshot(activeRoom),
          },
          'Relay websocket disconnected',
        );

        cleanupRoomIfIdle(fastify, activeRoom, {
          reason: 'no_host_no_client',
          triggerRole: meta.role,
          disconnectCode: code,
          disconnectReason: reason || null,
        });
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
