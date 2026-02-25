import process from 'node:process';
import net from 'node:net';

import {
  createH264Encoder,
  type H264Encoder,
  type H264EncoderImplementation,
  type H264NaluChunk,
  type H264Profile,
  type RawFramePixelFormat,
  type RawVideoFrame,
} from '../encode/h264Encoder.js';
import { parseStreamId, streamIdToHex } from './udpProtocol.js';

type ArgsMap = Map<string, string>;

type RelayHostConfig = {
  relayUrl: string;
  sessionId: string;
  userId: string;
  authToken: string;
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  inputPixelFormat: RawFramePixelFormat;
  profile: H264Profile;
  bitrateKbps: number;
  keyframeInterval: number;
  preferredEncoder: H264EncoderImplementation | 'auto';
  ffmpegPath?: string;
  streamId: Buffer;
  streamIdText: string;
  pacingKbps: number;
  statsIntervalSec: number;
  authExpiresAtMs?: number;
  minBitrateKbps: number;
  bitrateStepPct: number;
  bitrateAdaptCooldownMs: number;
  keyframeCooldownMs: number;
  inputForwardEnabled: boolean;
  inputForwardHost: string;
  inputForwardPort: number;
  inputForwardMaxEventsPerSec: number;
  inputForwardMaxPending: number;
  inputForwardTimeoutMs: number;
};

type SenderStats = {
  startedAtMs: number;
  framesInput: number;
  framesEncoded: number;
  keyframes: number;
  messagesSent: number;
  bytesSent: number;
  pacingWaitMs: number;
  encodeErrors: number;
  feedbackMessages: number;
  feedbackReports: number;
  feedbackPings: number;
  feedbackPongsSent: number;
  feedbackInvalid: number;
  feedbackRejectedAuth: number;
  feedbackRejectedSession: number;
  feedbackRejectedStream: number;
  feedbackKeyframeRequests: number;
  feedbackReconnectRequests: number;
  feedbackBitrateDrops: number;
  controlMessages: number;
  controlInvalid: number;
  inputMessages: number;
  inputRejectedAuth: number;
  inputRejectedSession: number;
  inputRejectedStream: number;
  inputForwarded: number;
  inputDroppedRate: number;
  inputDroppedBackpressure: number;
  inputForwardErrors: number;
  relaySendErrors: number;
  currentBitrateKbps: number;
};

type FeedbackControlMessage = {
  type: 'request_keyframe' | 'report_stats' | 'reconnect';
  token?: string;
  sessionId?: string;
  streamId?: string;
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

type StreamPingControlMessage = {
  type: 'stream_ping';
  token?: string;
  sessionId?: string;
  streamId?: string;
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

type RelayControlMessage =
  | { kind: 'feedback'; payload: FeedbackControlMessage }
  | { kind: 'stream_ping'; payload: StreamPingControlMessage }
  | { kind: 'input_event'; payload: RelayInputEnvelope };

type RelayWelcomeMessage = {
  type: 'relay.welcome';
  role: string;
  sessionId: string;
  streamId: string;
  connectedAt?: string;
};

type EncoderControlState = {
  currentBitrateKbps: number;
  pendingBitrateKbps: number | null;
  pendingForceIdr: boolean;
  lastKeyframeRequestAtMs: number;
  lastBitrateDropAtMs: number;
  lastProfileUpgradeAtMs: number;
  lastNetworkDegradedAtMs: number;
  lastKeyframeLogAtMs: number;
};

type BitrateProfileName = 'low' | 'medium' | 'high';

type BitrateProfileState = {
  name: BitrateProfileName;
  bitrateKbps: number;
};

const RELAY_FLAG_KEYFRAME = 1 << 0;
const RELAY_FRAME_HEADER_SIZE = 9;
const H264_NAL_SPS = 7;
const H264_NAL_PPS = 8;
const MAX_CONTROL_MESSAGE_BYTES = 4096;
const DEFAULT_DURATION_SEC = 600;
const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 720;
const DEFAULT_FPS = 30;
const DEFAULT_BITRATE_KBPS = 6000;
const DEFAULT_STATS_INTERVAL_SEC = 1;
const DEFAULT_MIN_BITRATE_KBPS = 1200;
const DEFAULT_BITRATE_STEP_PCT = 0.85;
const DEFAULT_BITRATE_ADAPT_COOLDOWN_MS = 1500;
const DEFAULT_KEYFRAME_COOLDOWN_MS = 350;
const DEFAULT_INPUT_FORWARD_HOST = '127.0.0.1';
const DEFAULT_INPUT_FORWARD_PORT = 5505;
const DEFAULT_INPUT_FORWARD_EVENTS_PER_SEC = 700;
const DEFAULT_INPUT_FORWARD_MAX_PENDING = 220;
const DEFAULT_INPUT_FORWARD_TIMEOUT_MS = 3000;
const RELAY_SEND_BUFFER_HIGH_WATERMARK_BYTES = 4 * 1024 * 1024;
const BITRATE_UP_STABLE_WINDOW_MS = 15_000;
const BITRATE_UP_COOLDOWN_MS = 10_000;
const BITRATE_RTT_DEGRADED_MS = 220;
const BITRATE_RTT_SEVERE_MS = 360;
const BITRATE_DROP_DEGRADED_PCT = 4;
const BITRATE_DROP_SEVERE_PCT = 8;
const KEYFRAME_LOG_SAMPLE_MS = 2_000;
const INPUT_MAX_MOUSE_DELTA = 3000;
const INPUT_MAX_WHEEL_DELTA = 2400;
const INPUT_MAX_SCANCODE_LEN = 64;
const INPUT_MAX_MOUSE_BUTTON = 5;

function parseNumber(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

function parsePixelFormat(raw: string | undefined): RawFramePixelFormat {
  const normalized = (raw ?? '').trim().toLowerCase();
  return normalized === 'rgba' ? 'rgba' : 'nv12';
}

function parseProfile(raw: string | undefined): H264Profile {
  const normalized = (raw ?? '').trim().toLowerCase();
  return normalized === 'main' ? 'main' : 'baseline';
}

function parsePreferredEncoder(raw: string | undefined): H264EncoderImplementation | 'auto' {
  const normalized = (raw ?? '').trim().toLowerCase();
  if (normalized === 'h264_nvenc') return 'h264_nvenc';
  if (normalized === 'h264_amf') return 'h264_amf';
  if (normalized === 'libx264') return 'libx264';
  if (normalized === 'libopenh264') return 'libopenh264';
  return 'auto';
}

function normalizeStreamIdText(value: string): string {
  return value.trim().toLowerCase().replace(/-/g, '');
}

function parseConfig(args: ArgsMap): RelayHostConfig {
  const relayUrl = (args.get('relay-url') ?? process.env.RELAY_URL ?? '').trim();
  const sessionId = (args.get('session-id') ?? process.env.SESSION_ID ?? '').trim();
  const userId = (args.get('user-id') ?? process.env.USER_ID ?? '').trim();
  const authToken = (args.get('auth-token') ?? process.env.STREAM_AUTH_TOKEN ?? '').trim();
  const streamIdRaw = (args.get('stream-id') ?? process.env.STREAM_ID ?? '').trim();
  if (!relayUrl) {
    throw new Error('relay-url obrigatorio.');
  }
  if (!sessionId) {
    throw new Error('session-id obrigatorio.');
  }
  if (!userId) {
    throw new Error('user-id obrigatorio.');
  }
  if (!authToken) {
    throw new Error('auth-token obrigatorio.');
  }
  if (!streamIdRaw) {
    throw new Error('stream-id obrigatorio.');
  }

  const streamId = parseStreamId(streamIdRaw);
  const streamIdText = streamIdToHex(streamId);
  const width = parseNumber(args.get('width'), DEFAULT_WIDTH, 64, 7680);
  const height = parseNumber(args.get('height'), DEFAULT_HEIGHT, 64, 4320);
  const fps = parseNumber(args.get('fps'), DEFAULT_FPS, 1, 240);
  const durationSec = parseNumber(args.get('duration-sec'), DEFAULT_DURATION_SEC, 1, 36000);
  const bitrateKbps = parseNumber(args.get('bitrate-kbps'), DEFAULT_BITRATE_KBPS, 200, 200000);
  const keyframeInterval = parseNumber(args.get('keyint'), Math.max(1, fps * 2), 1, fps * 10);
  const statsIntervalSec = parseNumber(args.get('stats-interval-sec'), DEFAULT_STATS_INTERVAL_SEC, 1, 30);
  const pacingRaw = args.get('pacing-kbps');
  const pacingKbps = pacingRaw
    ? parseNumber(pacingRaw, bitrateKbps, 200, 400000)
    : Math.max(200, Math.round(bitrateKbps * 1.1));
  const authExpiresAtRaw = args.get('auth-expires-at-ms')?.trim();
  const authExpiresAtMs = authExpiresAtRaw ? Number(authExpiresAtRaw) : undefined;
  const minBitrateKbps = parseNumber(
    args.get('min-bitrate-kbps'),
    Math.max(DEFAULT_MIN_BITRATE_KBPS, Math.round(bitrateKbps * 0.35)),
    100,
    bitrateKbps,
  );
  const bitrateStepPctRaw = Number(args.get('bitrate-step-pct') ?? DEFAULT_BITRATE_STEP_PCT);
  const bitrateStepPct = Number.isFinite(bitrateStepPctRaw)
    ? Math.max(0.55, Math.min(0.98, bitrateStepPctRaw))
    : DEFAULT_BITRATE_STEP_PCT;
  const bitrateAdaptCooldownMs = parseNumber(
    args.get('bitrate-adapt-cooldown-ms'),
    DEFAULT_BITRATE_ADAPT_COOLDOWN_MS,
    250,
    60_000,
  );
  const keyframeCooldownMs = parseNumber(
    args.get('keyframe-cooldown-ms'),
    DEFAULT_KEYFRAME_COOLDOWN_MS,
    50,
    10_000,
  );
  const inputForwardMode = (
    args.get('input-forward')
    ?? process.env.RELAY_INPUT_FORWARD
    ?? 'enabled'
  )
    .trim()
    .toLowerCase();
  const inputForwardEnabled = !['0', 'false', 'off', 'disabled', 'no'].includes(inputForwardMode);
  const inputForwardHost =
    (args.get('input-forward-host') ?? process.env.RELAY_INPUT_FORWARD_HOST ?? DEFAULT_INPUT_FORWARD_HOST).trim()
    || DEFAULT_INPUT_FORWARD_HOST;
  const inputForwardPort = parseNumber(
    args.get('input-forward-port') ?? process.env.RELAY_INPUT_FORWARD_PORT,
    DEFAULT_INPUT_FORWARD_PORT,
    1,
    65535,
  );
  const inputForwardMaxEventsPerSec = parseNumber(
    args.get('input-forward-max-events-per-sec') ?? process.env.RELAY_INPUT_FORWARD_MAX_EVENTS_PER_SEC,
    DEFAULT_INPUT_FORWARD_EVENTS_PER_SEC,
    50,
    10_000,
  );
  const inputForwardMaxPending = parseNumber(
    args.get('input-forward-max-pending') ?? process.env.RELAY_INPUT_FORWARD_MAX_PENDING,
    DEFAULT_INPUT_FORWARD_MAX_PENDING,
    8,
    20_000,
  );
  const inputForwardTimeoutMs = parseNumber(
    args.get('input-forward-timeout-ms') ?? process.env.RELAY_INPUT_FORWARD_TIMEOUT_MS,
    DEFAULT_INPUT_FORWARD_TIMEOUT_MS,
    100,
    30_000,
  );

  return {
    relayUrl,
    sessionId,
    userId,
    authToken,
    durationSec,
    width,
    height,
    fps,
    inputPixelFormat: parsePixelFormat(args.get('pixel-format') ?? process.env.H264_INPUT_PIXFMT),
    profile: parseProfile(args.get('profile') ?? process.env.H264_PROFILE),
    bitrateKbps,
    keyframeInterval,
    preferredEncoder: parsePreferredEncoder(args.get('encoder') ?? process.env.H264_ENCODER),
    ffmpegPath: args.get('ffmpeg-path') ?? process.env.FFMPEG_PATH ?? undefined,
    streamId,
    streamIdText,
    pacingKbps,
    statsIntervalSec,
    authExpiresAtMs:
      typeof authExpiresAtMs === 'number' && Number.isFinite(authExpiresAtMs)
        ? Math.trunc(authExpiresAtMs)
        : undefined,
    minBitrateKbps,
    bitrateStepPct,
    bitrateAdaptCooldownMs,
    keyframeCooldownMs,
    inputForwardEnabled,
    inputForwardHost,
    inputForwardPort,
    inputForwardMaxEventsPerSec,
    inputForwardMaxPending,
    inputForwardTimeoutMs,
  };
}

function nowUs(): number {
  return Math.max(0, Math.trunc(Date.now() * 1000));
}

function buildBitrateProfiles(config: RelayHostConfig): BitrateProfileState[] {
  const high = Math.max(config.minBitrateKbps, config.bitrateKbps);
  const medium = Math.max(config.minBitrateKbps, Math.trunc(high * 0.75));
  const low = Math.max(config.minBitrateKbps, Math.trunc(high * 0.5));

  const normalizedMedium = Math.min(high, Math.max(low, medium));
  const normalizedLow = Math.min(normalizedMedium, low);

  return [
    { name: 'low', bitrateKbps: normalizedLow },
    { name: 'medium', bitrateKbps: normalizedMedium },
    { name: 'high', bitrateKbps: high },
  ];
}

function parseJsonObject(rawText: string): Record<string, unknown> | null {
  const text = rawText.trim();
  if (!text || text.length > MAX_CONTROL_MESSAGE_BYTES) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  return parsed as Record<string, unknown>;
}

function parseRelayWelcomeMessage(rawText: string): RelayWelcomeMessage | null {
  const input = parseJsonObject(rawText);
  if (!input) return null;

  const typeRaw = typeof input.type === 'string' ? input.type.trim().toLowerCase() : '';
  if (typeRaw !== 'relay.welcome') return null;

  const role = typeof input.role === 'string' ? input.role.trim().toLowerCase() : '';
  const sessionId = typeof input.sessionId === 'string' ? input.sessionId.trim() : '';
  const streamId = typeof input.streamId === 'string' ? input.streamId.trim() : '';
  const connectedAt = typeof input.connectedAt === 'string' ? input.connectedAt : undefined;
  if (!role || !sessionId || !streamId) return null;

  return {
    type: 'relay.welcome',
    role,
    sessionId,
    streamId,
    connectedAt,
  };
}

function parseRelayInputEvent(raw: unknown): RelayInputEvent | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const input = raw as Record<string, unknown>;
  const typeRaw = typeof input.type === 'string' ? input.type.trim().toLowerCase() : '';
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
    return { type: 'mouse_button', seq, tsUs, button, down: Boolean(input.down) };
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
    return {
      type: 'key',
      seq,
      tsUs,
      scancode: scancodeValue,
      down: Boolean(input.down),
      ctrl: input.ctrl === undefined ? undefined : Boolean(input.ctrl),
      alt: input.alt === undefined ? undefined : Boolean(input.alt),
      shift: input.shift === undefined ? undefined : Boolean(input.shift),
      meta: input.meta === undefined ? undefined : Boolean(input.meta),
    };
  }

  if (typeRaw === 'disconnect_hotkey') {
    return { type: 'disconnect_hotkey', seq, tsUs };
  }

  return null;
}

function parseControlMessage(rawText: string): RelayControlMessage | null {
  const input = parseJsonObject(rawText);
  if (!input) return null;

  const typeRaw = typeof input.type === 'string' ? input.type.trim().toLowerCase() : '';
  if (typeRaw === 'stream_ping') {
    const pingId = typeof input.pingId === 'number' ? Math.max(0, Math.trunc(input.pingId)) : -1;
    const sentAtUs = typeof input.sentAtUs === 'number' ? Math.max(0, Math.trunc(input.sentAtUs)) : -1;
    return pingId >= 0 && sentAtUs >= 0
      ? {
          kind: 'stream_ping',
          payload: {
            type: 'stream_ping',
            token: typeof input.token === 'string' ? input.token : undefined,
            sessionId: typeof input.sessionId === 'string' ? input.sessionId : undefined,
            streamId: typeof input.streamId === 'string' ? input.streamId : undefined,
            pingId,
            sentAtUs,
          },
        }
      : null;
  }

  if (['keyframe_request', 'request_keyframe', 'network_report', 'report_stats', 'reconnect'].includes(typeRaw)) {
    const normalizedType: FeedbackControlMessage['type'] =
      typeRaw === 'keyframe_request'
        ? 'request_keyframe'
        : typeRaw === 'network_report'
          ? 'report_stats'
          : (typeRaw as FeedbackControlMessage['type']);
    return {
      kind: 'feedback',
      payload: {
        type: normalizedType,
        token: typeof input.token === 'string' ? input.token : undefined,
        sessionId: typeof input.sessionId === 'string' ? input.sessionId : undefined,
        streamId: typeof input.streamId === 'string' ? input.streamId : undefined,
        lossPct: typeof input.lossPct === 'number' ? input.lossPct : undefined,
        jitterMs: typeof input.jitterMs === 'number' ? input.jitterMs : undefined,
        freezeMs: typeof input.freezeMs === 'number' ? Math.max(0, Math.trunc(input.freezeMs)) : undefined,
        requestedBitrateKbps:
          typeof input.requestedBitrateKbps === 'number'
            ? Math.max(100, Math.trunc(input.requestedBitrateKbps))
            : undefined,
        reason: typeof input.reason === 'string' ? input.reason : undefined,
        sentAtUs: typeof input.sentAtUs === 'number' ? Math.max(0, Math.trunc(input.sentAtUs)) : undefined,
        fpsDecode: typeof input.fpsDecode === 'number' ? Number(input.fpsDecode) : undefined,
        rttMs: typeof input.rttMs === 'number' ? Number(input.rttMs) : undefined,
        dropRatePct: typeof input.dropRatePct === 'number' ? Number(input.dropRatePct) : undefined,
        bufferLevel: typeof input.bufferLevel === 'number' ? Number(input.bufferLevel) : undefined,
        bitrateKbps: typeof input.bitrateKbps === 'number' ? Number(input.bitrateKbps) : undefined,
        status: typeof input.status === 'string' ? input.status.trim().toLowerCase() : undefined,
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

function serializeInputEventForLocal(event: RelayInputEvent): string {
  const payload =
    event.type === 'mouse_move'
      ? { type: 'mouse_move', seq: event.seq, tsUs: event.tsUs, dx: event.dx, dy: event.dy }
      : event.type === 'mouse_button'
        ? {
            type: 'mouse_button',
            seq: event.seq,
            tsUs: event.tsUs,
            button: event.button,
            down: event.down,
          }
        : event.type === 'mouse_wheel'
          ? {
              type: 'mouse_wheel',
              seq: event.seq,
              tsUs: event.tsUs,
              deltaX: event.deltaX,
              deltaY: event.deltaY,
            }
          : event.type === 'key'
            ? {
                type: 'key',
                seq: event.seq,
                tsUs: event.tsUs,
                code: event.scancode,
                down: event.down,
                ctrl: event.ctrl ?? false,
                alt: event.alt ?? false,
                shift: event.shift ?? false,
                meta: event.meta ?? false,
              }
            : { type: 'disconnect_hotkey', seq: event.seq, tsUs: event.tsUs };
  return JSON.stringify(payload);
}

class LocalInputForwarder {
  private socket: net.Socket | null = null;
  private connectInFlight: Promise<void> | null = null;
  private sendChain: Promise<void> = Promise.resolve();
  private pendingEvents = 0;
  private rateWindowStartMs = 0;
  private eventsInWindow = 0;

  constructor(private readonly config: RelayHostConfig, private readonly stats: SenderStats) {}

  enqueue(event: RelayInputEvent): void {
    if (this.pendingEvents >= this.config.inputForwardMaxPending) {
      this.stats.inputDroppedBackpressure += 1;
      return;
    }

    this.pendingEvents += 1;
    this.sendChain = this.sendChain
      .then(async () => {
        const now = Date.now();
        if (now - this.rateWindowStartMs >= 1000) {
          this.rateWindowStartMs = now;
          this.eventsInWindow = 0;
        }
        this.eventsInWindow += 1;
        if (this.eventsInWindow > this.config.inputForwardMaxEventsPerSec) {
          this.stats.inputDroppedRate += 1;
          return;
        }

        await this.ensureConnected();
        await this.writeLine(serializeInputEventForLocal(event));
        this.stats.inputForwarded += 1;
      })
      .catch((error) => {
        this.stats.inputForwardErrors += 1;
        this.destroySocket();
        console.error(
          JSON.stringify({
            tag: 'host-daemon',
            event: 'relay_input_forward_error',
            message: error instanceof Error ? error.message : String(error ?? 'erro desconhecido'),
          }),
        );
      })
      .finally(() => {
        this.pendingEvents = Math.max(0, this.pendingEvents - 1);
      });
  }

  async close(): Promise<void> {
    await this.sendChain.catch(() => undefined);
    this.destroySocket();
  }

  private async ensureConnected(): Promise<void> {
    if (this.socket && !this.socket.destroyed && this.socket.writable) {
      return;
    }
    if (!this.connectInFlight) {
      this.connectInFlight = this.connectAndAuth().finally(() => {
        this.connectInFlight = null;
      });
    }
    await this.connectInFlight;
  }

  private async connectAndAuth(): Promise<void> {
    this.destroySocket();
    const socket = new net.Socket();

    try {
      await new Promise<void>((resolve, reject) => {
        let finished = false;
        const timeoutId = setTimeout(() => {
          done(() => reject(new Error(`timeout conectar input local (${this.config.inputForwardTimeoutMs}ms)`)));
        }, this.config.inputForwardTimeoutMs);

        const done = (fn: () => void) => {
          if (finished) return;
          finished = true;
          clearTimeout(timeoutId);
          socket.off('connect', onConnect);
          socket.off('error', onError);
          fn();
        };

        const onConnect = () => done(resolve);
        const onError = (error: Error) => done(() => reject(error));

        socket.on('connect', onConnect);
        socket.on('error', onError);
        socket.connect(this.config.inputForwardPort, this.config.inputForwardHost);
      });

      socket.setNoDelay(true);
      socket.setKeepAlive(true, 1000);

      const authPayload = JSON.stringify({
        type: 'auth',
        token: this.config.authToken,
        sessionId: this.config.sessionId,
        streamId: this.config.streamIdText,
        version: 1,
      });
      await this.writeLineOnSocket(socket, authPayload);

      const authResponseLine = await this.readLine(socket, this.config.inputForwardTimeoutMs);
      const authResponse = parseJsonObject(authResponseLine);
      if (!authResponse || authResponse.type !== 'auth_ok') {
        const reason =
          typeof authResponse?.reason === 'string' ? authResponse.reason : 'auth_rejected';
        throw new Error(`input local auth recusada (${reason})`);
      }

      socket.on('close', () => {
        if (this.socket === socket) {
          this.socket = null;
        }
      });
      socket.on('error', () => {
        if (this.socket === socket) {
          this.socket = null;
        }
      });
      this.socket = socket;
    } catch (error) {
      if (!socket.destroyed) {
        socket.destroy();
      }
      throw error;
    }
  }

  private async writeLine(line: string): Promise<void> {
    const socket = this.socket;
    if (!socket || socket.destroyed || !socket.writable) {
      throw new Error('input forward socket indisponivel');
    }
    await this.writeLineOnSocket(socket, line);
  }

  private async writeLineOnSocket(socket: net.Socket, line: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      if (socket.destroyed || !socket.writable) {
        reject(new Error('input forward socket indisponivel'));
        return;
      }
      socket.write(`${line}\n`, 'utf8', (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  private async readLine(socket: net.Socket, timeoutMs: number): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      let buffered = '';
      const timeoutId = setTimeout(() => {
        cleanup();
        reject(new Error(`timeout aguardando resposta do input local (${timeoutMs}ms)`));
      }, timeoutMs);

      const cleanup = () => {
        clearTimeout(timeoutId);
        socket.off('data', onData);
        socket.off('error', onError);
        socket.off('close', onClose);
      };

      const onData = (chunk: Buffer) => {
        buffered += chunk.toString('utf8');
        const lineEnd = buffered.indexOf('\n');
        if (lineEnd < 0) return;
        const line = buffered.slice(0, lineEnd).trim();
        cleanup();
        resolve(line);
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const onClose = () => {
        cleanup();
        reject(new Error('socket input local fechou durante autenticacao'));
      };

      socket.on('data', onData);
      socket.on('error', onError);
      socket.on('close', onClose);
    });
  }

  private destroySocket(): void {
    const socket = this.socket;
    this.socket = null;
    if (!socket) return;
    if (!socket.destroyed) {
      socket.destroy();
    }
  }
}

function makeNv12Frame(width: number, height: number, frameIndex: number): Buffer {
  const yPlaneSize = width * height;
  const uvPlaneSize = Math.trunc(yPlaneSize / 2);
  const out = Buffer.allocUnsafe(yPlaneSize + uvPlaneSize);

  const yValue = 16 + ((frameIndex * 2) % 180);
  out.fill(yValue, 0, yPlaneSize);
  const uValue = 96 + ((frameIndex * 3) % 80);
  const vValue = 96 + ((frameIndex * 5) % 80);
  for (let i = yPlaneSize; i < yPlaneSize + uvPlaneSize; i += 2) {
    out[i] = uValue;
    out[i + 1] = vValue;
  }

  const boxW = Math.max(8, Math.min(120, Math.trunc(width * 0.12)));
  const boxH = Math.max(8, Math.min(120, Math.trunc(height * 0.12)));
  const maxX = Math.max(1, width - boxW - 1);
  const maxY = Math.max(1, height - boxH - 1);
  const offsetX = (frameIndex * 9) % maxX;
  const offsetY = (frameIndex * 6) % maxY;
  const boxValue = 220;
  for (let y = 0; y < boxH; y += 1) {
    const row = offsetY + y;
    const rowStart = row * width + offsetX;
    out.fill(boxValue, rowStart, rowStart + boxW);
  }
  return out;
}

function makeRgbaFrame(width: number, height: number, frameIndex: number): Buffer {
  const out = Buffer.allocUnsafe(width * height * 4);
  const shift = frameIndex % 255;
  let offset = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      out[offset] = (x + shift) & 0xff;
      out[offset + 1] = (y + shift * 2) & 0xff;
      out[offset + 2] = (x + y + shift * 3) & 0xff;
      out[offset + 3] = 255;
      offset += 4;
    }
  }
  return out;
}

function makeFrame(config: RelayHostConfig, frameIndex: number): RawVideoFrame {
  const data =
    config.inputPixelFormat === 'nv12'
      ? makeNv12Frame(config.width, config.height, frameIndex)
      : makeRgbaFrame(config.width, config.height, frameIndex);
  return {
    width: config.width,
    height: config.height,
    pixelFormat: config.inputPixelFormat,
    timestampUs: Date.now() * 1000,
    data,
  };
}

function buildAnnexBFromNalus(nalus: Buffer[]): Buffer {
  if (nalus.length === 0) return Buffer.alloc(0);
  const startCodeSize = 4;
  const total = nalus.reduce((sum, nalu) => sum + startCodeSize + nalu.length, 0);
  const out = Buffer.allocUnsafe(total);
  let offset = 0;
  for (const nalu of nalus) {
    out.writeUInt32BE(0x00000001, offset);
    offset += startCodeSize;
    nalu.copy(out, offset);
    offset += nalu.length;
  }
  return out;
}

type CodecConfigState = {
  sps: Buffer | null;
  pps: Buffer | null;
};

function updateCodecConfigState(state: CodecConfigState, chunk: H264NaluChunk): void {
  for (const nalu of chunk.nalus) {
    if (nalu.length === 0) continue;
    const nalType = nalu[0] & 0x1f;
    if (nalType === H264_NAL_SPS) {
      state.sps = Buffer.from(nalu);
      continue;
    }
    if (nalType === H264_NAL_PPS) {
      state.pps = Buffer.from(nalu);
    }
  }
}

function buildCodecConfigAnnexB(state: CodecConfigState): Buffer | null {
  if (!state.sps || !state.pps) return null;
  return buildAnnexBFromNalus([state.sps, state.pps]);
}

function buildRelayFrame(chunk: H264NaluChunk, codecConfigAnnexB?: Buffer | null): Buffer {
  let payload = chunk.annexB;
  if (chunk.isKeyframe && !chunk.hasSps && !chunk.hasPps && codecConfigAnnexB && codecConfigAnnexB.length > 0) {
    payload = Buffer.concat([codecConfigAnnexB, payload]);
  }
  const out = Buffer.allocUnsafe(RELAY_FRAME_HEADER_SIZE + payload.length);
  out[0] = chunk.isKeyframe ? RELAY_FLAG_KEYFRAME : 0;
  out.writeBigUInt64BE(chunk.producedAtUs >= 0 ? BigInt(chunk.producedAtUs) : 0n, 1);
  payload.copy(out, RELAY_FRAME_HEADER_SIZE);
  return out;
}

function nowMs(): number {
  return Number(process.hrtime.bigint()) / 1_000_000;
}

async function sleepMs(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve) => setTimeout(resolve, Math.ceil(ms)));
}

class BytePacer {
  private nextDueMs = nowMs();
  public totalWaitMs = 0;

  constructor(private readonly targetKbps: number) {}

  async pace(packetBytes: number): Promise<void> {
    if (!Number.isFinite(this.targetKbps) || this.targetKbps <= 0) return;
    const now = nowMs();
    if (this.nextDueMs < now) {
      this.nextDueMs = now;
    }

    const waitMs = this.nextDueMs - now;
    if (waitMs >= 0.7) {
      this.totalWaitMs += waitMs;
      await sleepMs(waitMs);
    }

    const packetDurationMs = ((packetBytes * 8) / (this.targetKbps * 1000)) * 1000;
    this.nextDueMs = Math.max(this.nextDueMs, nowMs()) + packetDurationMs;
  }
}

function buildRelayConnectUrl(config: RelayHostConfig): string {
  const url = new URL(config.relayUrl);
  url.searchParams.set('role', 'host');
  url.searchParams.set('sessionId', config.sessionId);
  url.searchParams.set('streamId', config.streamIdText);
  url.searchParams.set('token', config.authToken);
  url.searchParams.set('userId', config.userId);
  return url.toString();
}

function sanitizeRelayConnectUrl(connectUrl: string): string {
  try {
    const url = new URL(connectUrl);
    if (url.searchParams.has('token')) {
      url.searchParams.set('token', '[redacted]');
    }
    return url.toString();
  } catch {
    return connectUrl;
  }
}

async function waitForSocketOpen(socket: WebSocket, timeoutMs: number): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) return;
  await new Promise<void>((resolve, reject) => {
    let resolved = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      socket.removeEventListener('open', onOpen);
      socket.removeEventListener('error', onError);
      socket.removeEventListener('close', onClose);
      if (timeoutId) clearTimeout(timeoutId);
    };

    const done = (fn: () => void) => {
      if (resolved) return;
      resolved = true;
      cleanup();
      fn();
    };

    const onOpen = () => done(resolve);
    const onError = () => done(() => reject(new Error('falha ao conectar relay websocket.')));
    const onClose = () => done(() => reject(new Error('relay websocket fechou antes de conectar.')));

    socket.addEventListener('open', onOpen);
    socket.addEventListener('error', onError);
    socket.addEventListener('close', onClose);
    timeoutId = setTimeout(
      () => done(() => reject(new Error(`timeout ao conectar relay websocket (${timeoutMs}ms).`))),
      timeoutMs,
    );
  });
}

async function waitForRelayWelcome(
  socket: WebSocket,
  config: RelayHostConfig,
  timeoutMs: number,
): Promise<RelayWelcomeMessage> {
  return new Promise<RelayWelcomeMessage>((resolve, reject) => {
    let settled = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      socket.removeEventListener('message', onMessage);
      socket.removeEventListener('close', onClose);
      socket.removeEventListener('error', onError);
      if (timeoutId) clearTimeout(timeoutId);
    };

    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };

    const onMessage = (event: MessageEvent) => {
      if (typeof event.data !== 'string') return;
      const welcome = parseRelayWelcomeMessage(event.data);
      if (!welcome) return;

      const roleMatches = welcome.role === 'host';
      const sessionMatches = welcome.sessionId === config.sessionId;
      const streamMatches = normalizeStreamIdText(welcome.streamId) === normalizeStreamIdText(config.streamIdText);
      if (!roleMatches || !sessionMatches || !streamMatches) {
        done(() =>
          reject(
            new Error(
              `relay.welcome invalido (role=${welcome.role}, sessionId=${welcome.sessionId}, streamId=${welcome.streamId}).`,
            ),
          ),
        );
        return;
      }

      done(() => resolve(welcome));
    };
    const onClose = () => done(() => reject(new Error('relay websocket fechou antes do relay.welcome.')));
    const onError = () => done(() => reject(new Error('erro no relay websocket antes do relay.welcome.')));

    socket.addEventListener('message', onMessage);
    socket.addEventListener('close', onClose);
    socket.addEventListener('error', onError);

    timeoutId = setTimeout(
      () => done(() => reject(new Error(`timeout aguardando relay.welcome (${timeoutMs}ms).`))),
      timeoutMs,
    );
  });
}

async function waitSocketBufferDrain(socket: WebSocket): Promise<void> {
  while (socket.readyState === WebSocket.OPEN && socket.bufferedAmount > RELAY_SEND_BUFFER_HIGH_WATERMARK_BYTES) {
    await sleepMs(2);
  }
}

async function sendRelayFrame(socket: WebSocket, payload: Buffer): Promise<void> {
  if (socket.readyState !== WebSocket.OPEN) {
    throw new Error('relay websocket desconectado.');
  }
  await waitSocketBufferDrain(socket);
  socket.send(payload);
}

function sendRelayControl(socket: WebSocket, payload: Record<string, unknown>): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(payload));
}

function closeSocketSafe(socket: WebSocket): void {
  if (socket.readyState === WebSocket.CLOSING || socket.readyState === WebSocket.CLOSED) return;
  try {
    socket.close(1000, 'normal_shutdown');
  } catch {
    // ignore
  }
}

function logStats(config: RelayHostConfig, stats: SenderStats): void {
  const elapsedSec = Math.max(0.001, (Date.now() - stats.startedAtMs) / 1000);
  const fpsInput = stats.framesInput / elapsedSec;
  const fpsEncoded = stats.framesEncoded / elapsedSec;
  const kbps = ((stats.bytesSent * 8) / 1000) / elapsedSec;
  const bytesPerSec = stats.bytesSent / elapsedSec;
  const msgRate = stats.messagesSent / elapsedSec;

  console.log(
    JSON.stringify({
      tag: 'host-daemon',
      event: 'relay_sender_stats',
      streamId: config.streamIdText,
      sessionId: config.sessionId,
      relayUrl: config.relayUrl,
      elapsedSec: Number(elapsedSec.toFixed(2)),
      framesInput: stats.framesInput,
      framesEncoded: stats.framesEncoded,
      keyframes: stats.keyframes,
      messagesSent: stats.messagesSent,
      bytesSent: stats.bytesSent,
      fpsInput: Number(fpsInput.toFixed(2)),
      fpsEncoded: Number(fpsEncoded.toFixed(2)),
      sendKbps: Number(kbps.toFixed(2)),
      bytesPerSec: Number(bytesPerSec.toFixed(2)),
      hostBytesPerSec: Number(bytesPerSec.toFixed(2)),
      msgRate: Number(msgRate.toFixed(2)),
      pacingWaitMs: Number(stats.pacingWaitMs.toFixed(2)),
      pacingKbps: config.pacingKbps,
      encodeErrors: stats.encodeErrors,
      relaySendErrors: stats.relaySendErrors,
      currentBitrateKbps: stats.currentBitrateKbps,
      feedbackMessages: stats.feedbackMessages,
      feedbackReports: stats.feedbackReports,
      feedbackPings: stats.feedbackPings,
      feedbackPongsSent: stats.feedbackPongsSent,
      feedbackInvalid: stats.feedbackInvalid,
      feedbackRejectedAuth: stats.feedbackRejectedAuth,
      feedbackRejectedSession: stats.feedbackRejectedSession,
      feedbackRejectedStream: stats.feedbackRejectedStream,
      feedbackKeyframeRequests: stats.feedbackKeyframeRequests,
      feedbackReconnectRequests: stats.feedbackReconnectRequests,
      feedbackBitrateDrops: stats.feedbackBitrateDrops,
      controlMessages: stats.controlMessages,
      controlInvalid: stats.controlInvalid,
      inputMessages: stats.inputMessages,
      inputRejectedAuth: stats.inputRejectedAuth,
      inputRejectedSession: stats.inputRejectedSession,
      inputRejectedStream: stats.inputRejectedStream,
      inputForwarded: stats.inputForwarded,
      inputDroppedRate: stats.inputDroppedRate,
      inputDroppedBackpressure: stats.inputDroppedBackpressure,
      inputForwardErrors: stats.inputForwardErrors,
    }),
  );
}

export async function runRelayHost(args: ArgsMap): Promise<void> {
  const config = parseConfig(args);
  const connectUrl = buildRelayConnectUrl(config);
  const safeConnectUrl = sanitizeRelayConnectUrl(connectUrl);

  console.log(
    JSON.stringify({
      tag: 'host-daemon',
      event: 'relay_sender_start_signal',
      sessionId: config.sessionId,
      streamId: config.streamIdText,
      relayUrl: config.relayUrl,
      relayConnectUrl: safeConnectUrl,
      authExpiresAtMs: config.authExpiresAtMs ?? null,
    }),
  );

  console.log(
    JSON.stringify({
      tag: 'host-daemon',
      event: 'relay_sender_ws_connect_attempt',
      sessionId: config.sessionId,
      streamId: config.streamIdText,
      url: safeConnectUrl,
    }),
  );

  const socket = new WebSocket(connectUrl);
  await waitForSocketOpen(socket, 8000);
  console.log(
    JSON.stringify({
      tag: 'host-daemon',
      event: 'relay_sender_ws_connected',
      sessionId: config.sessionId,
      streamId: config.streamIdText,
      url: safeConnectUrl,
      readyState: socket.readyState,
    }),
  );

  const welcome = await waitForRelayWelcome(socket, config, 4000);
  console.log(
    JSON.stringify({
      tag: 'host-daemon',
      event: 'relay_sender_room_joined',
      role: welcome.role,
      sessionId: welcome.sessionId,
      streamId: welcome.streamId,
      connectedAt: welcome.connectedAt ?? null,
    }),
  );

  const pacer = new BytePacer(config.pacingKbps);
  let encoder: H264Encoder = createH264Encoder({
    width: config.width,
    height: config.height,
    fps: config.fps,
    inputPixelFormat: config.inputPixelFormat,
    profile: config.profile,
    bitrateKbps: config.bitrateKbps,
    keyframeInterval: config.keyframeInterval,
    preferredEncoder: config.preferredEncoder,
    ffmpegPath: config.ffmpegPath,
  });
  let selection = encoder.getSelection();

  const control: EncoderControlState = {
    currentBitrateKbps: config.bitrateKbps,
    pendingBitrateKbps: null,
    pendingForceIdr: false,
    lastKeyframeRequestAtMs: 0,
    lastBitrateDropAtMs: 0,
    lastProfileUpgradeAtMs: 0,
    lastNetworkDegradedAtMs: Date.now(),
    lastKeyframeLogAtMs: 0,
  };
  const bitrateProfiles = buildBitrateProfiles(config);
  let bitrateProfileIndex = Math.max(0, bitrateProfiles.findIndex((profile) => profile.bitrateKbps >= config.bitrateKbps));
  if (bitrateProfileIndex < 0) {
    bitrateProfileIndex = bitrateProfiles.length - 1;
  }
  const stats: SenderStats = {
    startedAtMs: Date.now(),
    framesInput: 0,
    framesEncoded: 0,
    keyframes: 0,
    messagesSent: 0,
    bytesSent: 0,
    pacingWaitMs: 0,
    encodeErrors: 0,
    feedbackMessages: 0,
    feedbackReports: 0,
    feedbackPings: 0,
    feedbackPongsSent: 0,
    feedbackInvalid: 0,
    feedbackRejectedAuth: 0,
    feedbackRejectedSession: 0,
    feedbackRejectedStream: 0,
    feedbackKeyframeRequests: 0,
    feedbackReconnectRequests: 0,
    feedbackBitrateDrops: 0,
    controlMessages: 0,
    controlInvalid: 0,
    inputMessages: 0,
    inputRejectedAuth: 0,
    inputRejectedSession: 0,
    inputRejectedStream: 0,
    inputForwarded: 0,
    inputDroppedRate: 0,
    inputDroppedBackpressure: 0,
    inputForwardErrors: 0,
    relaySendErrors: 0,
    currentBitrateKbps: config.bitrateKbps,
  };
  const normalizedStreamId = normalizeStreamIdText(config.streamIdText);
  const inputForwarder = config.inputForwardEnabled ? new LocalInputForwarder(config, stats) : null;

  let socketClosed = false;
  let socketCloseCode = 1000;
  let socketCloseReason = '';

  const requestEncoderReconfigure = async (reason: string): Promise<void> => {
    const targetBitrate = control.pendingBitrateKbps ?? control.currentBitrateKbps;
    if (!control.pendingForceIdr && targetBitrate === control.currentBitrateKbps) {
      return;
    }

    let nextEncoder: H264Encoder;
    try {
      nextEncoder = createH264Encoder({
        width: config.width,
        height: config.height,
        fps: config.fps,
        inputPixelFormat: config.inputPixelFormat,
        profile: config.profile,
        bitrateKbps: targetBitrate,
        keyframeInterval: config.keyframeInterval,
        preferredEncoder: config.preferredEncoder,
        ffmpegPath: config.ffmpegPath,
      });
    } catch (error) {
      console.error(
        JSON.stringify({
          tag: 'host-daemon',
          event: 'relay_sender_encoder_reconfigure_failed',
          reason,
          targetBitrateKbps: targetBitrate,
          message: error instanceof Error ? error.message : String(error ?? 'erro desconhecido'),
        }),
      );
      control.pendingBitrateKbps = null;
      control.pendingForceIdr = false;
      return;
    }

    const previousBitrate = control.currentBitrateKbps;
    await encoder.close().catch(() => undefined);
    encoder = nextEncoder;
    selection = encoder.getSelection();
    control.currentBitrateKbps = targetBitrate;
    control.pendingBitrateKbps = null;
    control.pendingForceIdr = false;
    stats.currentBitrateKbps = targetBitrate;

    console.log(
      JSON.stringify({
        tag: 'host-daemon',
        event: 'relay_sender_encoder_reconfigured',
        reason,
        previousBitrateKbps: previousBitrate,
        currentBitrateKbps: targetBitrate,
        encoder: selection.implementation,
      }),
    );
  };

  socket.addEventListener('close', (event) => {
    socketClosed = true;
    socketCloseCode = event.code;
    socketCloseReason = event.reason;
    console.warn(
      JSON.stringify({
        tag: 'host-daemon',
        event: 'relay_sender_ws_closed',
        sessionId: config.sessionId,
        streamId: config.streamIdText,
        code: event.code,
        reason: event.reason || null,
        wasClean: event.wasClean,
      }),
    );
  });

  socket.addEventListener('error', () => {
    socketClosed = true;
    console.error(
      JSON.stringify({
        tag: 'host-daemon',
        event: 'relay_sender_ws_error',
        sessionId: config.sessionId,
        streamId: config.streamIdText,
      }),
    );
  });

  socket.addEventListener('message', (event) => {
    if (typeof event.data !== 'string') {
      return;
    }
    const welcome = parseRelayWelcomeMessage(event.data);
    if (welcome) {
      console.log(
        JSON.stringify({
          tag: 'host-daemon',
          event: 'relay_sender_welcome_ack',
          role: welcome.role,
          sessionId: welcome.sessionId,
          streamId: welcome.streamId,
          connectedAt: welcome.connectedAt ?? null,
        }),
      );
      return;
    }
    stats.controlMessages += 1;
    const controlMessage = parseControlMessage(event.data);
    if (!controlMessage) {
      stats.controlInvalid += 1;
      stats.feedbackInvalid += 1;
      return;
    }
    const now = Date.now();

    if (controlMessage.kind === 'stream_ping') {
      const ping = controlMessage.payload;
      stats.feedbackPings += 1;
      if (ping.token !== config.authToken) {
        stats.feedbackRejectedAuth += 1;
        return;
      }
      if (config.authExpiresAtMs && now > config.authExpiresAtMs) {
        stats.feedbackRejectedAuth += 1;
        return;
      }
      if (!ping.sessionId || ping.sessionId.trim() !== config.sessionId) {
        stats.feedbackRejectedSession += 1;
        return;
      }
      if (!ping.streamId || normalizeStreamIdText(ping.streamId) !== normalizedStreamId) {
        stats.feedbackRejectedStream += 1;
        return;
      }

      sendRelayControl(socket, {
        type: 'stream_pong',
        sessionId: config.sessionId,
        streamId: config.streamIdText,
        pingId: ping.pingId,
        sentAtUs: ping.sentAtUs,
        receivedAtUs: nowUs(),
        hostTsUs: nowUs(),
      });
      stats.feedbackPongsSent += 1;
      return;
    }

    if (controlMessage.kind === 'feedback') {
      const feedback = controlMessage.payload;
      stats.feedbackMessages += 1;

      if (feedback.token !== config.authToken) {
        stats.feedbackRejectedAuth += 1;
        return;
      }
      if (config.authExpiresAtMs && now > config.authExpiresAtMs) {
        stats.feedbackRejectedAuth += 1;
        return;
      }
      if (feedback.sessionId && feedback.sessionId.trim() !== config.sessionId) {
        stats.feedbackRejectedSession += 1;
        return;
      }
      if (feedback.streamId) {
        const provided = normalizeStreamIdText(feedback.streamId);
        if (normalizedStreamId !== provided) {
          stats.feedbackRejectedStream += 1;
          return;
        }
      }

      if (feedback.type === 'request_keyframe') {
        if (now - control.lastKeyframeRequestAtMs >= config.keyframeCooldownMs) {
          control.pendingForceIdr = true;
          control.lastKeyframeRequestAtMs = now;
          stats.feedbackKeyframeRequests += 1;
          if (now - control.lastKeyframeLogAtMs >= KEYFRAME_LOG_SAMPLE_MS) {
            control.lastKeyframeLogAtMs = now;
            console.log(
              JSON.stringify({
                tag: 'host-daemon',
                event: 'relay_sender_keyframe_requested',
                reason: feedback.reason ?? 'client_request',
                freezeMs: feedback.freezeMs ?? null,
              }),
            );
          }
        }
        return;
      }

      if (feedback.type === 'reconnect') {
        if (now - control.lastKeyframeRequestAtMs >= config.keyframeCooldownMs) {
          control.pendingForceIdr = true;
          control.lastKeyframeRequestAtMs = now;
        }
        stats.feedbackReconnectRequests += 1;
        return;
      }

      stats.feedbackReports += 1;
      const lossPct = Number.isFinite(feedback.lossPct) ? Math.max(0, Math.min(100, Number(feedback.lossPct))) : 0;
      const jitterMs = Number.isFinite(feedback.jitterMs) ? Math.max(0, Number(feedback.jitterMs)) : 0;
      const rttMs = Number.isFinite(feedback.rttMs) ? Math.max(0, Number(feedback.rttMs)) : 0;
      const dropRatePct = Number.isFinite(feedback.dropRatePct)
        ? Math.max(0, Math.min(100, Number(feedback.dropRatePct)))
        : 0;
      const fpsDecode = Number.isFinite(feedback.fpsDecode) ? Math.max(0, Number(feedback.fpsDecode)) : 0;
      const severe =
        lossPct >= BITRATE_DROP_SEVERE_PCT
        || jitterMs >= 45
        || rttMs >= BITRATE_RTT_SEVERE_MS
        || dropRatePct >= BITRATE_DROP_SEVERE_PCT;
      const degraded =
        severe
        || lossPct >= 3.5
        || jitterMs >= 25
        || rttMs >= BITRATE_RTT_DEGRADED_MS
        || dropRatePct >= BITRATE_DROP_DEGRADED_PCT
        || (fpsDecode > 0 && fpsDecode < config.fps * 0.72);

      if (degraded) {
        control.lastNetworkDegradedAtMs = now;
      }

      let targetProfileIndex = bitrateProfileIndex;
      if (
        degraded
        && bitrateProfileIndex > 0
        && now - control.lastBitrateDropAtMs >= config.bitrateAdaptCooldownMs
      ) {
        targetProfileIndex = Math.max(0, bitrateProfileIndex - 1);
      } else if (
        !degraded
        && bitrateProfileIndex < bitrateProfiles.length - 1
        && now - control.lastNetworkDegradedAtMs >= BITRATE_UP_STABLE_WINDOW_MS
        && now - control.lastProfileUpgradeAtMs >= BITRATE_UP_COOLDOWN_MS
      ) {
        targetProfileIndex = Math.min(bitrateProfiles.length - 1, bitrateProfileIndex + 1);
      }

      if (targetProfileIndex !== bitrateProfileIndex) {
        const previousProfileIndex = bitrateProfileIndex;
        const targetProfile = bitrateProfiles[targetProfileIndex];
        const previousProfile = bitrateProfiles[previousProfileIndex];
        bitrateProfileIndex = targetProfileIndex;

        if (targetProfile.bitrateKbps !== control.currentBitrateKbps) {
          control.pendingBitrateKbps = targetProfile.bitrateKbps;
          control.pendingForceIdr = true;
        }
        if (targetProfileIndex < previousProfileIndex) {
          control.lastBitrateDropAtMs = now;
          stats.feedbackBitrateDrops += 1;
        } else {
          control.lastProfileUpgradeAtMs = now;
        }

        console.log(
          JSON.stringify({
            tag: 'host-daemon',
            event: 'relay_sender_bitrate_profile_changed',
            fromProfile: previousProfile.name,
            toProfile: targetProfile.name,
            fromBitrateKbps: previousProfile.bitrateKbps,
            targetBitrateKbps: targetProfile.bitrateKbps,
            degraded,
            severe,
            lossPct: Number(lossPct.toFixed(2)),
            jitterMs: Number(jitterMs.toFixed(3)),
            rttMs: Number(rttMs.toFixed(2)),
            dropRatePct: Number(dropRatePct.toFixed(2)),
            fpsDecode: Number(fpsDecode.toFixed(2)),
            reason: feedback.reason ?? null,
          }),
        );
      }
      return;
    }

    const inputMessage = controlMessage.payload;
    stats.inputMessages += 1;

    if (inputMessage.token !== config.authToken) {
      stats.inputRejectedAuth += 1;
      return;
    }
    if (config.authExpiresAtMs && Date.now() > config.authExpiresAtMs) {
      stats.inputRejectedAuth += 1;
      return;
    }
    if (inputMessage.sessionId.trim() !== config.sessionId) {
      stats.inputRejectedSession += 1;
      return;
    }
    if (normalizeStreamIdText(inputMessage.streamId) !== normalizedStreamId) {
      stats.inputRejectedStream += 1;
      return;
    }
    if (!inputForwarder) {
      stats.inputForwardErrors += 1;
      return;
    }

    inputForwarder.enqueue(inputMessage.event);
  });

  console.log(
    JSON.stringify({
      tag: 'host-daemon',
      event: 'relay_sender_start',
      streamId: config.streamIdText,
      sessionId: config.sessionId,
      relayUrl: config.relayUrl,
      durationSec: config.durationSec,
      width: config.width,
      height: config.height,
      fps: config.fps,
      pixelFormat: config.inputPixelFormat,
      profile: config.profile,
      bitrateKbps: config.bitrateKbps,
      keyframeInterval: config.keyframeInterval,
      encoder: selection.implementation,
      encoderReason: selection.reason,
      gpuVendor: selection.gpuVendor,
      pacingKbps: config.pacingKbps,
      authExpiresAtMs: config.authExpiresAtMs ?? null,
      minBitrateKbps: config.minBitrateKbps,
      bitrateStepPct: config.bitrateStepPct,
      bitrateAdaptCooldownMs: config.bitrateAdaptCooldownMs,
      keyframeCooldownMs: config.keyframeCooldownMs,
      inputForwardEnabled: config.inputForwardEnabled,
      inputForwardHost: config.inputForwardHost,
      inputForwardPort: config.inputForwardPort,
      inputForwardMaxEventsPerSec: config.inputForwardMaxEventsPerSec,
      inputForwardMaxPending: config.inputForwardMaxPending,
      inputForwardTimeoutMs: config.inputForwardTimeoutMs,
      protocol: 'relay_h264_annexb_v1',
      inputProtocol: 'relay_input_event_v1',
      bitrateProfiles,
      activeBitrateProfile: bitrateProfiles[bitrateProfileIndex]?.name ?? 'high',
    }),
  );

  const totalInputFrames = config.durationSec * config.fps;
  const frameIntervalMs = 1000 / config.fps;
  const loopStartMs = Date.now();
  let lastStatsLogMs = loopStartMs;
  const codecConfigState: CodecConfigState = { sps: null, pps: null };

  try {
    for (let frameIndex = 0; frameIndex < totalInputFrames; frameIndex += 1) {
      if (socketClosed || socket.readyState !== WebSocket.OPEN) {
        throw new Error(
          `relay websocket fechado durante envio (code=${socketCloseCode}, reason=${socketCloseReason || 'n/a'}).`,
        );
      }

      const plannedAt = loopStartMs + frameIndex * frameIntervalMs;
      const now = Date.now();
      if (plannedAt > now) {
        await sleepMs(plannedAt - now);
      }

      if (control.pendingForceIdr || control.pendingBitrateKbps !== null) {
        await requestEncoderReconfigure('feedback');
      }

      const frame = makeFrame(config, frameIndex);
      stats.framesInput += 1;

      let chunks: H264NaluChunk[] = [];
      try {
        chunks = await encoder.encode(frame);
      } catch (error) {
        stats.encodeErrors += 1;
        console.error(
          JSON.stringify({
            tag: 'host-daemon',
            event: 'relay_sender_encode_error',
            frameIndex,
            message: error instanceof Error ? error.message : String(error ?? 'erro desconhecido'),
          }),
        );
        continue;
      }

      for (const chunk of chunks) {
        stats.framesEncoded += 1;
        if (chunk.isKeyframe) {
          stats.keyframes += 1;
        }
        if (chunk.hasSps || chunk.hasPps) {
          updateCodecConfigState(codecConfigState, chunk);
        }
        const payload = buildRelayFrame(chunk, buildCodecConfigAnnexB(codecConfigState));

        try {
          await pacer.pace(payload.length);
          await sendRelayFrame(socket, payload);
          stats.messagesSent += 1;
          stats.bytesSent += payload.length;
        } catch (error) {
          stats.relaySendErrors += 1;
          throw new Error(
            `falha ao enviar frame no relay: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      const nowForStats = Date.now();
      if (nowForStats - lastStatsLogMs >= config.statsIntervalSec * 1000) {
        stats.pacingWaitMs = pacer.totalWaitMs;
        logStats(config, stats);
        lastStatsLogMs = nowForStats;
      }
    }

    const tailChunks = await encoder.flush();
    for (const chunk of tailChunks) {
      if (chunk.hasSps || chunk.hasPps) {
        updateCodecConfigState(codecConfigState, chunk);
      }
      const payload = buildRelayFrame(chunk, buildCodecConfigAnnexB(codecConfigState));
      await pacer.pace(payload.length);
      await sendRelayFrame(socket, payload);
      stats.framesEncoded += 1;
      if (chunk.isKeyframe) stats.keyframes += 1;
      stats.messagesSent += 1;
      stats.bytesSent += payload.length;
    }
  } finally {
    stats.pacingWaitMs = pacer.totalWaitMs;
    if (inputForwarder) {
      await inputForwarder.close().catch(() => undefined);
    }
    await encoder.close().catch(() => undefined);
    closeSocketSafe(socket);
    await sleepMs(120);
  }

  logStats(config, stats);
  console.log(
    JSON.stringify({
      tag: 'host-daemon',
      event: 'relay_sender_summary',
      result: 'ok',
      streamId: config.streamIdText,
      sessionId: config.sessionId,
      relayUrl: config.relayUrl,
      framesInput: stats.framesInput,
      framesEncoded: stats.framesEncoded,
      keyframes: stats.keyframes,
      messagesSent: stats.messagesSent,
      bytesSent: stats.bytesSent,
      encodeErrors: stats.encodeErrors,
      relaySendErrors: stats.relaySendErrors,
      pacingWaitMs: Number(stats.pacingWaitMs.toFixed(2)),
      currentBitrateKbps: stats.currentBitrateKbps,
      feedbackMessages: stats.feedbackMessages,
      feedbackReports: stats.feedbackReports,
      feedbackPings: stats.feedbackPings,
      feedbackPongsSent: stats.feedbackPongsSent,
      feedbackInvalid: stats.feedbackInvalid,
      feedbackRejectedAuth: stats.feedbackRejectedAuth,
      feedbackRejectedSession: stats.feedbackRejectedSession,
      feedbackRejectedStream: stats.feedbackRejectedStream,
      feedbackKeyframeRequests: stats.feedbackKeyframeRequests,
      feedbackReconnectRequests: stats.feedbackReconnectRequests,
      feedbackBitrateDrops: stats.feedbackBitrateDrops,
      controlMessages: stats.controlMessages,
      controlInvalid: stats.controlInvalid,
      inputMessages: stats.inputMessages,
      inputRejectedAuth: stats.inputRejectedAuth,
      inputRejectedSession: stats.inputRejectedSession,
      inputRejectedStream: stats.inputRejectedStream,
      inputForwarded: stats.inputForwarded,
      inputDroppedRate: stats.inputDroppedRate,
      inputDroppedBackpressure: stats.inputDroppedBackpressure,
      inputForwardErrors: stats.inputForwardErrors,
      socketCloseCode,
      socketCloseReason: socketCloseReason || null,
      durationSec: Number(((Date.now() - stats.startedAtMs) / 1000).toFixed(2)),
    }),
  );
}
