import process from 'node:process';

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
  feedbackInvalid: number;
  feedbackRejectedAuth: number;
  feedbackRejectedSession: number;
  feedbackRejectedStream: number;
  feedbackKeyframeRequests: number;
  feedbackReconnectRequests: number;
  feedbackBitrateDrops: number;
  relaySendErrors: number;
  currentBitrateKbps: number;
};

type FeedbackControlMessage = {
  type: 'keyframe_request' | 'network_report' | 'reconnect';
  token?: string;
  sessionId?: string;
  streamId?: string;
  lossPct?: number;
  jitterMs?: number;
  freezeMs?: number;
  requestedBitrateKbps?: number;
  reason?: string;
  sentAtUs?: number;
};

type EncoderControlState = {
  currentBitrateKbps: number;
  pendingBitrateKbps: number | null;
  pendingForceIdr: boolean;
  lastKeyframeRequestAtMs: number;
  lastBitrateDropAtMs: number;
};

const RELAY_FLAG_KEYFRAME = 1 << 0;
const RELAY_FRAME_HEADER_SIZE = 9;
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
const RELAY_SEND_BUFFER_HIGH_WATERMARK_BYTES = 4 * 1024 * 1024;

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
  };
}

function parseFeedbackMessage(rawText: string): FeedbackControlMessage | null {
  const text = rawText.trim();
  if (!text || text.length > 4096) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;

  const input = parsed as Record<string, unknown>;
  const typeRaw = typeof input.type === 'string' ? input.type.trim().toLowerCase() : '';
  if (!['keyframe_request', 'network_report', 'reconnect'].includes(typeRaw)) {
    return null;
  }

  return {
    type: typeRaw as FeedbackControlMessage['type'],
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
  };
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

function buildRelayFrame(chunk: H264NaluChunk): Buffer {
  const payload = chunk.annexB;
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
      msgRate: Number(msgRate.toFixed(2)),
      pacingWaitMs: Number(stats.pacingWaitMs.toFixed(2)),
      pacingKbps: config.pacingKbps,
      encodeErrors: stats.encodeErrors,
      relaySendErrors: stats.relaySendErrors,
      currentBitrateKbps: stats.currentBitrateKbps,
      feedbackMessages: stats.feedbackMessages,
      feedbackInvalid: stats.feedbackInvalid,
      feedbackRejectedAuth: stats.feedbackRejectedAuth,
      feedbackRejectedSession: stats.feedbackRejectedSession,
      feedbackRejectedStream: stats.feedbackRejectedStream,
      feedbackKeyframeRequests: stats.feedbackKeyframeRequests,
      feedbackReconnectRequests: stats.feedbackReconnectRequests,
      feedbackBitrateDrops: stats.feedbackBitrateDrops,
    }),
  );
}

export async function runRelayHost(args: ArgsMap): Promise<void> {
  const config = parseConfig(args);
  const connectUrl = buildRelayConnectUrl(config);
  const socket = new WebSocket(connectUrl);
  await waitForSocketOpen(socket, 8000);

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
  };
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
    feedbackInvalid: 0,
    feedbackRejectedAuth: 0,
    feedbackRejectedSession: 0,
    feedbackRejectedStream: 0,
    feedbackKeyframeRequests: 0,
    feedbackReconnectRequests: 0,
    feedbackBitrateDrops: 0,
    relaySendErrors: 0,
    currentBitrateKbps: config.bitrateKbps,
  };

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
  });

  socket.addEventListener('error', () => {
    socketClosed = true;
  });

  socket.addEventListener('message', (event) => {
    if (typeof event.data !== 'string') {
      return;
    }
    const feedback = parseFeedbackMessage(event.data);
    if (!feedback) {
      stats.feedbackInvalid += 1;
      return;
    }
    stats.feedbackMessages += 1;

    if (feedback.token !== config.authToken) {
      stats.feedbackRejectedAuth += 1;
      return;
    }
    if (config.authExpiresAtMs && Date.now() > config.authExpiresAtMs) {
      stats.feedbackRejectedAuth += 1;
      return;
    }
    if (feedback.sessionId && feedback.sessionId.trim() !== config.sessionId) {
      stats.feedbackRejectedSession += 1;
      return;
    }
    if (feedback.streamId) {
      const expected = normalizeStreamIdText(config.streamIdText);
      const provided = normalizeStreamIdText(feedback.streamId);
      if (expected !== provided) {
        stats.feedbackRejectedStream += 1;
        return;
      }
    }

    const now = Date.now();
    if (feedback.type === 'keyframe_request') {
      if (now - control.lastKeyframeRequestAtMs >= config.keyframeCooldownMs) {
        control.pendingForceIdr = true;
        control.lastKeyframeRequestAtMs = now;
        stats.feedbackKeyframeRequests += 1;
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

    const lossPct = Number.isFinite(feedback.lossPct) ? Math.max(0, Math.min(100, Number(feedback.lossPct))) : 0;
    const jitterMs = Number.isFinite(feedback.jitterMs) ? Math.max(0, Number(feedback.jitterMs)) : 0;
    const severe = lossPct >= 8 || jitterMs >= 45;
    const degraded = lossPct >= 4 || jitterMs >= 25;
    if (!severe && !degraded) {
      return;
    }
    if (now - control.lastBitrateDropAtMs < config.bitrateAdaptCooldownMs) {
      return;
    }

    const requestedCeil = Number.isFinite(feedback.requestedBitrateKbps)
      ? Math.max(config.minBitrateKbps, Math.trunc(Number(feedback.requestedBitrateKbps)))
      : control.currentBitrateKbps;
    const factor = severe ? Math.min(config.bitrateStepPct, 0.78) : config.bitrateStepPct;
    const targetBitrate = Math.max(
      config.minBitrateKbps,
      Math.min(requestedCeil, Math.trunc(control.currentBitrateKbps * factor)),
    );
    if (targetBitrate >= control.currentBitrateKbps) {
      return;
    }

    control.pendingBitrateKbps = targetBitrate;
    control.pendingForceIdr = true;
    control.lastBitrateDropAtMs = now;
    stats.feedbackBitrateDrops += 1;
    console.log(
      JSON.stringify({
        tag: 'host-daemon',
        event: 'relay_sender_bitrate_drop_requested',
        fromBitrateKbps: control.currentBitrateKbps,
        targetBitrateKbps: targetBitrate,
        lossPct: Number(lossPct.toFixed(2)),
        jitterMs: Number(jitterMs.toFixed(3)),
        reason: feedback.reason ?? null,
      }),
    );
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
      protocol: 'relay_h264_annexb_v1',
    }),
  );

  const totalInputFrames = config.durationSec * config.fps;
  const frameIntervalMs = 1000 / config.fps;
  const loopStartMs = Date.now();
  let lastStatsLogMs = loopStartMs;

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
        const payload = buildRelayFrame(chunk);

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
      const payload = buildRelayFrame(chunk);
      await pacer.pace(payload.length);
      await sendRelayFrame(socket, payload);
      stats.framesEncoded += 1;
      if (chunk.isKeyframe) stats.keyframes += 1;
      stats.messagesSent += 1;
      stats.bytesSent += payload.length;
    }
  } finally {
    stats.pacingWaitMs = pacer.totalWaitMs;
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
      feedbackInvalid: stats.feedbackInvalid,
      feedbackRejectedAuth: stats.feedbackRejectedAuth,
      feedbackRejectedSession: stats.feedbackRejectedSession,
      feedbackRejectedStream: stats.feedbackRejectedStream,
      feedbackKeyframeRequests: stats.feedbackKeyframeRequests,
      feedbackReconnectRequests: stats.feedbackReconnectRequests,
      feedbackBitrateDrops: stats.feedbackBitrateDrops,
      durationSec: Number(((Date.now() - stats.startedAtMs) / 1000).toFixed(2)),
    }),
  );
}
