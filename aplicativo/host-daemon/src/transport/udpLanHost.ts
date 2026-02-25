import dgram from 'node:dgram';
import process from 'node:process';

import {
  createH264Encoder,
  type H264Encoder,
  type H264EncoderImplementation,
  type H264Profile,
  type RawFramePixelFormat,
  type RawVideoFrame,
} from '../encode/h264Encoder.js';
import {
  UDP_FLAG_KEYFRAME,
  packetizeFrame,
  parseStreamId,
  randomStreamId,
  streamIdToHex,
} from './udpProtocol.js';

type ArgsMap = Map<string, string>;

type HostConfig = {
  targetHost: string;
  targetPort: number;
  bindPort: number;
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
  maxPayloadBytes: number;
  pacingKbps: number;
  statsIntervalSec: number;
  authToken?: string;
  authExpiresAtMs?: number;
  sessionId?: string;
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
  packetsSent: number;
  bytesSent: number;
  pacingWaitMs: number;
  encodeErrors: number;
  feedbackPackets: number;
  feedbackInvalid: number;
  feedbackRejectedAuth: number;
  feedbackRejectedSession: number;
  feedbackRejectedStream: number;
  feedbackKeyframeRequests: number;
  feedbackReconnectRequests: number;
  feedbackBitrateDrops: number;
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

const DEFAULT_PORT = 5004;
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

function parseConfig(args: ArgsMap): HostConfig {
  const targetHost = (args.get('target-host') ?? args.get('host') ?? '127.0.0.1').trim();
  const targetPort = parseNumber(args.get('target-port') ?? args.get('port'), DEFAULT_PORT, 1, 65535);
  const bindPortRaw = args.get('bind-port');
  const bindPort = bindPortRaw ? parseNumber(bindPortRaw, 0, 0, 65535) : 0;

  const width = parseNumber(args.get('width'), DEFAULT_WIDTH, 64, 7680);
  const height = parseNumber(args.get('height'), DEFAULT_HEIGHT, 64, 4320);
  const fps = parseNumber(args.get('fps'), DEFAULT_FPS, 1, 240);
  const durationSec = parseNumber(args.get('duration-sec'), DEFAULT_DURATION_SEC, 1, 36000);
  const bitrateKbps = parseNumber(args.get('bitrate-kbps'), DEFAULT_BITRATE_KBPS, 200, 200000);
  const keyframeInterval = parseNumber(args.get('keyint'), Math.max(1, fps * 2), 1, fps * 10);
  const statsIntervalSec = parseNumber(
    args.get('stats-interval-sec'),
    DEFAULT_STATS_INTERVAL_SEC,
    1,
    30,
  );
  const maxPayloadBytes = parseNumber(args.get('max-payload-bytes'), 1100, 256, 1400);

  const pacingRaw = args.get('pacing-kbps');
  const pacingKbps = pacingRaw
    ? parseNumber(pacingRaw, bitrateKbps, 200, 400000)
    : Math.max(200, Math.round(bitrateKbps * 1.1));

  const streamIdRaw = args.get('stream-id')?.trim();
  const streamId = streamIdRaw ? parseStreamId(streamIdRaw) : randomStreamId();
  const authToken = args.get('auth-token')?.trim() || undefined;
  const authExpiresAtRaw = args.get('auth-expires-at-ms')?.trim();
  const authExpiresAtMs = authExpiresAtRaw ? Number(authExpiresAtRaw) : undefined;
  const sessionId = args.get('session-id')?.trim() || undefined;
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
    targetHost,
    targetPort,
    bindPort,
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
    maxPayloadBytes,
    pacingKbps,
    statsIntervalSec,
    authToken,
    authExpiresAtMs:
      typeof authExpiresAtMs === 'number' && Number.isFinite(authExpiresAtMs)
        ? Math.trunc(authExpiresAtMs)
        : undefined,
    sessionId,
    minBitrateKbps,
    bitrateStepPct,
    bitrateAdaptCooldownMs,
    keyframeCooldownMs,
  };
}

function normalizeStreamIdText(value: string): string {
  return value.trim().toLowerCase().replace(/-/g, '');
}

function parseFeedbackMessage(datagram: Buffer): FeedbackControlMessage | null {
  if (datagram.length === 0 || datagram.length > 2048) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(datagram.toString('utf8').trim());
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object') return null;
  const input = parsed as Record<string, unknown>;
  const typeRaw = typeof input.type === 'string' ? input.type.trim().toLowerCase() : '';
  if (!['keyframe_request', 'network_report', 'reconnect'].includes(typeRaw)) {
    return null;
  }

  const value: FeedbackControlMessage = {
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

  return value;
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

function makeFrame(config: HostConfig, frameIndex: number): RawVideoFrame {
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

function nowMs(): number {
  return Number(process.hrtime.bigint()) / 1_000_000;
}

async function sleepMs(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve) => setTimeout(resolve, Math.ceil(ms)));
}

class UdpPacer {
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

    const packetDurationMs = (packetBytes * 8) / (this.targetKbps * 1000) * 1000;
    this.nextDueMs = Math.max(this.nextDueMs, nowMs()) + packetDurationMs;
  }
}

async function sendPacket(socket: dgram.Socket, packet: Buffer, port: number, host: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    socket.send(packet, port, host, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function logStats(config: HostConfig, stats: SenderStats): void {
  const elapsedSec = Math.max(0.001, (Date.now() - stats.startedAtMs) / 1000);
  const fpsInput = stats.framesInput / elapsedSec;
  const fpsEncoded = stats.framesEncoded / elapsedSec;
  const kbps = ((stats.bytesSent * 8) / 1000) / elapsedSec;
  const packetRate = stats.packetsSent / elapsedSec;

  console.log(
    JSON.stringify({
      tag: 'host-daemon',
      event: 'udp_sender_stats',
      streamId: streamIdToHex(config.streamId),
      targetHost: config.targetHost,
      targetPort: config.targetPort,
      elapsedSec: Number(elapsedSec.toFixed(2)),
      framesInput: stats.framesInput,
      framesEncoded: stats.framesEncoded,
      keyframes: stats.keyframes,
      packetsSent: stats.packetsSent,
      bytesSent: stats.bytesSent,
      fpsInput: Number(fpsInput.toFixed(2)),
      fpsEncoded: Number(fpsEncoded.toFixed(2)),
      sendKbps: Number(kbps.toFixed(2)),
      packetRate: Number(packetRate.toFixed(2)),
      pacingWaitMs: Number(stats.pacingWaitMs.toFixed(2)),
      pacingKbps: config.pacingKbps,
      encodeErrors: stats.encodeErrors,
      currentBitrateKbps: stats.currentBitrateKbps,
      feedbackPackets: stats.feedbackPackets,
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

export async function runUdpLanHost(args: ArgsMap): Promise<void> {
  const config = parseConfig(args);
  const socket = dgram.createSocket('udp4');
  const pacer = new UdpPacer(config.pacingKbps);

  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject);
    socket.bind(config.bindPort, () => {
      socket.off('error', reject);
      resolve();
    });
  });

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
    packetsSent: 0,
    bytesSent: 0,
    pacingWaitMs: 0,
    encodeErrors: 0,
    feedbackPackets: 0,
    feedbackInvalid: 0,
    feedbackRejectedAuth: 0,
    feedbackRejectedSession: 0,
    feedbackRejectedStream: 0,
    feedbackKeyframeRequests: 0,
    feedbackReconnectRequests: 0,
    feedbackBitrateDrops: 0,
    currentBitrateKbps: config.bitrateKbps,
  };
  const streamIdHex = streamIdToHex(config.streamId);
  const isFeedbackAuthEnabled = Boolean(config.authToken && config.authToken.trim().length > 0);

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
          event: 'udp_sender_encoder_reconfigure_failed',
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
        event: 'udp_sender_encoder_reconfigured',
        reason,
        previousBitrateKbps: previousBitrate,
        currentBitrateKbps: targetBitrate,
        encoder: selection.implementation,
      }),
    );
  };

  socket.on('message', (datagram, rinfo) => {
    const feedback = parseFeedbackMessage(datagram);
    if (!feedback) {
      stats.feedbackInvalid += 1;
      return;
    }
    stats.feedbackPackets += 1;

    if (isFeedbackAuthEnabled) {
      if (feedback.token !== config.authToken) {
        stats.feedbackRejectedAuth += 1;
        return;
      }
    }

    if (config.sessionId) {
      const sessionMatches = feedback.sessionId && feedback.sessionId.trim() === config.sessionId;
      if (!sessionMatches) {
        stats.feedbackRejectedSession += 1;
        return;
      }
    }
    if (feedback.streamId) {
      const expected = normalizeStreamIdText(streamIdHex);
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
        event: 'udp_sender_bitrate_drop_requested',
        sourceAddress: rinfo.address,
        sourcePort: rinfo.port,
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
      event: 'udp_sender_start',
      streamId: streamIdHex,
      targetHost: config.targetHost,
      targetPort: config.targetPort,
      bindPort: typeof socket.address() === 'string' ? null : socket.address().port,
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
      maxPayloadBytes: config.maxPayloadBytes,
      authRequired: isFeedbackAuthEnabled,
      authExpiresAtMs: config.authExpiresAtMs ?? null,
      sessionId: config.sessionId ?? null,
      minBitrateKbps: config.minBitrateKbps,
      bitrateStepPct: config.bitrateStepPct,
      bitrateAdaptCooldownMs: config.bitrateAdaptCooldownMs,
      keyframeCooldownMs: config.keyframeCooldownMs,
      protocol: 'udp_h264_annexb_v1',
    }),
  );

  let seq = 0;
  const totalInputFrames = config.durationSec * config.fps;
  const frameIntervalMs = 1000 / config.fps;
  const loopStartMs = Date.now();
  let lastStatsLogMs = loopStartMs;

  try {
    for (let frameIndex = 0; frameIndex < totalInputFrames; frameIndex += 1) {
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

      let chunks = [];
      try {
        chunks = await encoder.encode(frame);
      } catch (error) {
        stats.encodeErrors += 1;
        console.error(
          JSON.stringify({
            tag: 'host-daemon',
            event: 'udp_sender_encode_error',
            frameIndex,
            message: error instanceof Error ? error.message : String(error ?? 'erro desconhecido'),
          }),
        );
        continue;
      }

      for (const chunk of chunks) {
        seq += 1;
        stats.framesEncoded += 1;
        if (chunk.isKeyframe) {
          stats.keyframes += 1;
        }
        const packets = packetizeFrame({
          streamId: config.streamId,
          seq,
          timestampUs: chunk.producedAtUs >= 0 ? BigInt(chunk.producedAtUs) : 0n,
          flags: chunk.isKeyframe ? UDP_FLAG_KEYFRAME : 0,
          framePayload: chunk.annexB,
          maxPayloadBytes: config.maxPayloadBytes,
        });

        for (const packet of packets) {
          await pacer.pace(packet.length);
          await sendPacket(socket, packet, config.targetPort, config.targetHost);
          stats.packetsSent += 1;
          stats.bytesSent += packet.length;
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
      seq += 1;
      stats.framesEncoded += 1;
      if (chunk.isKeyframe) stats.keyframes += 1;
      const packets = packetizeFrame({
        streamId: config.streamId,
        seq,
        timestampUs: chunk.producedAtUs >= 0 ? BigInt(chunk.producedAtUs) : 0n,
        flags: chunk.isKeyframe ? UDP_FLAG_KEYFRAME : 0,
        framePayload: chunk.annexB,
        maxPayloadBytes: config.maxPayloadBytes,
      });
      for (const packet of packets) {
        await pacer.pace(packet.length);
        await sendPacket(socket, packet, config.targetPort, config.targetHost);
        stats.packetsSent += 1;
        stats.bytesSent += packet.length;
      }
    }
  } finally {
    stats.pacingWaitMs = pacer.totalWaitMs;
    await encoder.close().catch(() => undefined);
    socket.close();
  }

  logStats(config, stats);
  console.log(
    JSON.stringify({
      tag: 'host-daemon',
      event: 'udp_sender_summary',
      result: 'ok',
      streamId: streamIdToHex(config.streamId),
      targetHost: config.targetHost,
      targetPort: config.targetPort,
      framesInput: stats.framesInput,
      framesEncoded: stats.framesEncoded,
      keyframes: stats.keyframes,
      packetsSent: stats.packetsSent,
      bytesSent: stats.bytesSent,
      encodeErrors: stats.encodeErrors,
      pacingWaitMs: Number(stats.pacingWaitMs.toFixed(2)),
      currentBitrateKbps: stats.currentBitrateKbps,
      feedbackPackets: stats.feedbackPackets,
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
