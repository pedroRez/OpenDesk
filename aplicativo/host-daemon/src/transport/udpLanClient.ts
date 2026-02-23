import { spawn, spawnSync, type ChildProcessByStdio } from 'node:child_process';
import dgram, { type RemoteInfo } from 'node:dgram';
import { createWriteStream, type WriteStream } from 'node:fs';
import { once } from 'node:events';
import path from 'node:path';
import process from 'node:process';
import type { Readable, Writable } from 'node:stream';

import { UDP_FLAG_KEYFRAME, parseStreamId, parseUdpPacket, streamIdToHex, type UdpPacket } from './udpProtocol.js';

type ArgsMap = Map<string, string>;

type DecoderKind = 'ffplay' | 'ffmpeg-null' | 'none';

type ClientConfig = {
  listenHost: string;
  listenPort: number;
  durationSec: number;
  expectedStreamId?: Buffer;
  maxFrameAgeMs: number;
  maxPendingFrames: number;
  statsIntervalSec: number;
  decoder: DecoderKind;
  ffplayPath: string;
  ffmpegPath: string;
  outputPath?: string;
};

type PendingFrame = {
  seq: number;
  timestampUs: bigint;
  flags: number;
  totalChunks: number;
  chunks: Array<Buffer | undefined>;
  receivedCount: number;
  firstArrivalMs: number;
  lastArrivalMs: number;
};

type ReceiverStats = {
  startedAtMs: number;
  packetsReceived: number;
  packetsAccepted: number;
  packetsInvalid: number;
  packetsStreamMismatch: number;
  packetsDuplicate: number;
  framesCompleted: number;
  framesDroppedTimeout: number;
  framesDroppedQueue: number;
  framesDroppedLate: number;
  framesDroppedGap: number;
  missingChunks: number;
  keyframesCompleted: number;
  bytesReassembled: number;
  seqGapFrames: number;
  jitterMs: number;
  decoderFramesFed: number;
  decoderWriteErrors: number;
  decodeFpsReported: number | null;
  firstPacketAtMs: number | null;
  remoteAddress: string | null;
  remotePort: number | null;
};

interface DecoderSink {
  readonly kind: DecoderKind;
  write(payload: Buffer): Promise<void>;
  close(): Promise<void>;
  getReportedFps(): number | null;
}

const DEFAULT_PORT = 5004;
const DEFAULT_DURATION_SEC = 600;
const DEFAULT_MAX_FRAME_AGE_MS = 40;
const DEFAULT_MAX_PENDING_FRAMES = 96;
const DEFAULT_STATS_INTERVAL_SEC = 1;
const PROCESS_CLOSE_TIMEOUT_MS = 2000;

function parseNumber(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

function parseDecoder(raw: string | undefined): DecoderKind {
  const normalized = (raw ?? '').trim().toLowerCase();
  if (normalized === 'none') return 'none';
  if (normalized === 'ffmpeg' || normalized === 'ffmpeg-null' || normalized === 'ffmpeg_null') {
    return 'ffmpeg-null';
  }
  return 'ffplay';
}

function parseConfig(args: ArgsMap): ClientConfig {
  const listenHost = (args.get('listen-host') ?? '0.0.0.0').trim();
  const listenPort = parseNumber(args.get('listen-port') ?? args.get('port'), DEFAULT_PORT, 1, 65535);
  const durationSec = parseNumber(args.get('duration-sec'), DEFAULT_DURATION_SEC, 1, 36000);
  const maxFrameAgeMs = parseNumber(args.get('max-frame-age-ms'), DEFAULT_MAX_FRAME_AGE_MS, 5, 5000);
  const maxPendingFrames = parseNumber(args.get('max-pending-frames'), DEFAULT_MAX_PENDING_FRAMES, 2, 4096);
  const statsIntervalSec = parseNumber(
    args.get('stats-interval-sec'),
    DEFAULT_STATS_INTERVAL_SEC,
    1,
    60,
  );
  const streamIdRaw = args.get('stream-id')?.trim();
  const expectedStreamId = streamIdRaw ? parseStreamId(streamIdRaw) : undefined;
  const decoder = parseDecoder(args.get('decoder'));
  const ffplayPath = args.get('ffplay-path') ?? process.env.FFPLAY_PATH ?? 'ffplay';
  const ffmpegPath = args.get('ffmpeg-path') ?? process.env.FFMPEG_PATH ?? 'ffmpeg';
  const outputRaw = args.get('output')?.trim();
  const outputPath = outputRaw ? path.resolve(outputRaw) : undefined;

  return {
    listenHost,
    listenPort,
    durationSec,
    expectedStreamId,
    maxFrameAgeMs,
    maxPendingFrames,
    statsIntervalSec,
    decoder,
    ffplayPath,
    ffmpegPath,
    outputPath,
  };
}

function streamIdEquals(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && a.compare(b) === 0;
}

function parseFpsFromLine(text: string): number | null {
  const direct = /fps=\s*([0-9]+(?:\.[0-9]+)?)/i.exec(text);
  if (direct && direct[1]) {
    const value = Number(direct[1]);
    if (Number.isFinite(value)) return value;
  }
  const suffix = /([0-9]+(?:\.[0-9]+)?)\s*fps/i.exec(text);
  if (suffix && suffix[1]) {
    const value = Number(suffix[1]);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

function assertBinaryAvailable(binaryPath: string): void {
  const probe = spawnSync(binaryPath, ['-version'], { encoding: 'utf8' });
  if (probe.error) {
    throw new Error(`binario nao encontrado (${binaryPath}). ${probe.error.message}`);
  }
}

class NoopDecoderSink implements DecoderSink {
  readonly kind: DecoderKind = 'none';
  async write(): Promise<void> {
    return;
  }
  async close(): Promise<void> {
    return;
  }
  getReportedFps(): number | null {
    return null;
  }
}

class ProcessDecoderSink implements DecoderSink {
  readonly kind: DecoderKind;
  private readonly child: ChildProcessByStdio<Writable, null, Readable>;
  private writeChain: Promise<void> = Promise.resolve();
  private closed = false;
  private fpsReported: number | null = null;
  private stderrTail = '';

  constructor(kind: DecoderKind, command: string, args: string[]) {
    this.kind = kind;
    assertBinaryAvailable(command);

    this.child = spawn(command, args, {
      stdio: ['pipe', 'ignore', 'pipe'],
      windowsHide: true,
    });
    if (!this.child.stdin || !this.child.stderr) {
      throw new Error(`falha ao iniciar decoder (${kind}).`);
    }

    this.child.stderr.on('data', (chunk: Buffer | string) => {
      const text = chunk.toString();
      this.stderrTail = `${this.stderrTail}${text}`;
      if (this.stderrTail.length > 8000) {
        this.stderrTail = this.stderrTail.slice(-8000);
      }
      const fps = parseFpsFromLine(text);
      if (fps !== null) {
        this.fpsReported = fps;
      }
    });

    this.child.on('error', (error) => {
      this.closed = true;
      console.error(
        JSON.stringify({
          tag: 'host-daemon',
          event: 'udp_receiver_decoder_error',
          decoder: this.kind,
          message: error instanceof Error ? error.message : String(error ?? 'erro desconhecido'),
        }),
      );
    });

    this.child.on('close', (code) => {
      this.closed = true;
      if (code !== 0) {
        console.error(
          JSON.stringify({
            tag: 'host-daemon',
            event: 'udp_receiver_decoder_exit',
            decoder: this.kind,
            code,
            stderrTail: this.stderrTail.trim(),
          }),
        );
      }
    });
  }

  write(payload: Buffer): Promise<void> {
    const job = this.writeChain.then(async () => this.writeInternal(payload));
    this.writeChain = job.catch(() => undefined);
    return job;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      this.child.stdin.end();
    } catch {
      // ignore
    }

    await Promise.race([
      once(this.child, 'close'),
      new Promise<void>((resolve) => setTimeout(resolve, PROCESS_CLOSE_TIMEOUT_MS)),
    ]).catch(() => undefined);

    if (!this.child.killed) {
      this.child.kill('SIGKILL');
    }
  }

  getReportedFps(): number | null {
    return this.fpsReported;
  }

  private async writeInternal(payload: Buffer): Promise<void> {
    if (this.closed) return;
    if (!this.child.stdin.writable) return;
    const canWrite = this.child.stdin.write(payload);
    if (canWrite) return;
    await once(this.child.stdin, 'drain');
  }
}

function createDecoderSink(config: ClientConfig): DecoderSink {
  if (config.decoder === 'none') {
    return new NoopDecoderSink();
  }

  if (config.decoder === 'ffmpeg-null') {
    const args = [
      '-hide_banner',
      '-loglevel',
      'info',
      '-fflags',
      'nobuffer',
      '-flags',
      'low_delay',
      '-f',
      'h264',
      '-i',
      'pipe:0',
      '-an',
      '-f',
      'null',
      '-',
    ];
    return new ProcessDecoderSink('ffmpeg-null', config.ffmpegPath, args);
  }

  const ffplayArgs = [
    '-hide_banner',
    '-loglevel',
    'info',
    '-fflags',
    'nobuffer',
    '-flags',
    'low_delay',
    '-framedrop',
    '-sync',
    'video',
    '-probesize',
    '32',
    '-analyzeduration',
    '0',
    '-f',
    'h264',
    '-i',
    'pipe:0',
  ];
  return new ProcessDecoderSink('ffplay', config.ffplayPath, ffplayArgs);
}

async function writeToFile(stream: WriteStream, payload: Buffer): Promise<void> {
  const canWrite = stream.write(payload);
  if (canWrite) return;
  await once(stream, 'drain');
}

async function closeFile(stream: WriteStream | null): Promise<void> {
  if (!stream) return;
  await new Promise<void>((resolve, reject) => {
    stream.end(() => resolve());
    stream.on('error', reject);
  }).catch(() => undefined);
}

function updateJitter(stats: ReceiverStats, packet: UdpPacket, arrivalMs: number, prevTransit: { value?: number }): void {
  const transit = arrivalMs - Number(packet.timestampUs) / 1000;
  if (typeof prevTransit.value === 'number') {
    const d = Math.abs(transit - prevTransit.value);
    stats.jitterMs += (d - stats.jitterMs) / 16;
  }
  prevTransit.value = transit;
}

function logReceiverStats(
  config: ClientConfig,
  stats: ReceiverStats,
  pendingCount: number,
  streamIdHex: string | null,
): void {
  const elapsedSec = Math.max(0.001, (Date.now() - stats.startedAtMs) / 1000);
  const fpsAssembled = stats.framesCompleted / elapsedSec;
  const fpsDecodeEstimate = stats.decoderFramesFed / elapsedSec;
  const bitrateKbps = ((stats.bytesReassembled * 8) / 1000) / elapsedSec;
  const lossPct = (stats.missingChunks / Math.max(1, stats.packetsAccepted + stats.missingChunks)) * 100;

  console.log(
    JSON.stringify({
      tag: 'host-daemon',
      event: 'udp_receiver_stats',
      listenHost: config.listenHost,
      listenPort: config.listenPort,
      streamId: streamIdHex,
      remoteAddress: stats.remoteAddress,
      remotePort: stats.remotePort,
      elapsedSec: Number(elapsedSec.toFixed(2)),
      packetsReceived: stats.packetsReceived,
      packetsAccepted: stats.packetsAccepted,
      packetsInvalid: stats.packetsInvalid,
      packetsDuplicate: stats.packetsDuplicate,
      packetsStreamMismatch: stats.packetsStreamMismatch,
      framesCompleted: stats.framesCompleted,
      framesDroppedTimeout: stats.framesDroppedTimeout,
      framesDroppedQueue: stats.framesDroppedQueue,
      framesDroppedLate: stats.framesDroppedLate,
      framesDroppedGap: stats.framesDroppedGap,
      keyframesCompleted: stats.keyframesCompleted,
      seqGapFrames: stats.seqGapFrames,
      missingChunks: stats.missingChunks,
      lossPct: Number(lossPct.toFixed(2)),
      jitterMs: Number(stats.jitterMs.toFixed(3)),
      fpsAssembled: Number(fpsAssembled.toFixed(2)),
      fpsDecodeEstimate: Number(fpsDecodeEstimate.toFixed(2)),
      fpsDecodeReported: stats.decodeFpsReported !== null ? Number(stats.decodeFpsReported.toFixed(2)) : null,
      bitrateKbps: Number(bitrateKbps.toFixed(2)),
      pendingFrames: pendingCount,
      decoder: config.decoder,
      outputPath: config.outputPath ?? null,
    }),
  );
}

export async function runUdpLanClient(args: ArgsMap): Promise<void> {
  const config = parseConfig(args);
  const decoder = createDecoderSink(config);
  const outputStream = config.outputPath ? createWriteStream(config.outputPath) : null;

  const socket = dgram.createSocket('udp4');
  const pending = new Map<number, PendingFrame>();
  const stats: ReceiverStats = {
    startedAtMs: Date.now(),
    packetsReceived: 0,
    packetsAccepted: 0,
    packetsInvalid: 0,
    packetsStreamMismatch: 0,
    packetsDuplicate: 0,
    framesCompleted: 0,
    framesDroppedTimeout: 0,
    framesDroppedQueue: 0,
    framesDroppedLate: 0,
    framesDroppedGap: 0,
    missingChunks: 0,
    keyframesCompleted: 0,
    bytesReassembled: 0,
    seqGapFrames: 0,
    jitterMs: 0,
    decoderFramesFed: 0,
    decoderWriteErrors: 0,
    decodeFpsReported: null,
    firstPacketAtMs: null,
    remoteAddress: null,
    remotePort: null,
  };

  const transit = { value: undefined as number | undefined };
  let stopRequested = false;
  let stopResolve: (() => void) | null = null;
  const stopPromise = new Promise<void>((resolve) => {
    stopResolve = resolve;
  });
  const requestStop = () => {
    if (stopRequested) return;
    stopRequested = true;
    if (stopResolve) stopResolve();
  };

  let writeChain: Promise<void> = Promise.resolve();
  let activeStreamId: Buffer | null = null;
  let lastSeqSeen: number | null = null;
  let lastDeliveredSeq = -1;

  const dropPendingFrame = (frame: PendingFrame, reason: 'timeout' | 'queue' | 'gap'): void => {
    pending.delete(frame.seq);
    const missing = Math.max(0, frame.totalChunks - frame.receivedCount);
    stats.missingChunks += missing;
    if (reason === 'timeout') stats.framesDroppedTimeout += 1;
    if (reason === 'queue') stats.framesDroppedQueue += 1;
    if (reason === 'gap') stats.framesDroppedGap += 1;
  };

  const enqueueDecoderPayload = (payload: Buffer): void => {
    writeChain = writeChain
      .then(async () => {
        if (outputStream) {
          await writeToFile(outputStream, payload);
        }
        await decoder.write(payload);
        stats.decoderFramesFed += 1;
      })
      .catch((error) => {
        stats.decoderWriteErrors += 1;
        console.error(
          JSON.stringify({
            tag: 'host-daemon',
            event: 'udp_receiver_decode_write_error',
            message: error instanceof Error ? error.message : String(error ?? 'erro desconhecido'),
          }),
        );
      });
  };

  const finalizeFrame = (frame: PendingFrame): void => {
    pending.delete(frame.seq);

    if (frame.seq <= lastDeliveredSeq) {
      stats.framesDroppedLate += 1;
      return;
    }

    if (frame.seq > lastDeliveredSeq + 1) {
      const gapFrames = frame.seq - lastDeliveredSeq - 1;
      if (gapFrames > 0 && lastDeliveredSeq >= 0) {
        stats.seqGapFrames += gapFrames;
      }
      for (const stale of Array.from(pending.values())) {
        if (stale.seq < frame.seq) {
          dropPendingFrame(stale, 'gap');
        }
      }
    }

    const orderedChunks: Buffer[] = [];
    for (let i = 0; i < frame.totalChunks; i += 1) {
      const chunk = frame.chunks[i];
      if (!chunk) {
        stats.framesDroppedTimeout += 1;
        stats.missingChunks += 1;
        return;
      }
      orderedChunks.push(chunk);
    }

    const payload = Buffer.concat(orderedChunks);
    stats.framesCompleted += 1;
    if ((frame.flags & UDP_FLAG_KEYFRAME) !== 0) {
      stats.keyframesCompleted += 1;
    }
    stats.bytesReassembled += payload.length;
    lastDeliveredSeq = frame.seq;
    enqueueDecoderPayload(payload);
  };

  const handlePacket = (packet: UdpPacket, rinfo: RemoteInfo): void => {
    if (config.expectedStreamId && !streamIdEquals(packet.streamId, config.expectedStreamId)) {
      stats.packetsStreamMismatch += 1;
      return;
    }

    if (!activeStreamId) {
      activeStreamId = Buffer.from(packet.streamId);
    } else if (!streamIdEquals(packet.streamId, activeStreamId)) {
      stats.packetsStreamMismatch += 1;
      return;
    }

    const now = Date.now();
    if (!stats.firstPacketAtMs) {
      stats.firstPacketAtMs = now;
      stats.remoteAddress = rinfo.address;
      stats.remotePort = rinfo.port;
    }

    updateJitter(stats, packet, now, transit);

    if (lastSeqSeen === null || packet.seq > lastSeqSeen) {
      if (lastSeqSeen !== null && packet.seq > lastSeqSeen + 1) {
        stats.seqGapFrames += packet.seq - lastSeqSeen - 1;
      }
      lastSeqSeen = packet.seq;
    }

    if (packet.seq <= lastDeliveredSeq) {
      stats.framesDroppedLate += 1;
      return;
    }

    let frame = pending.get(packet.seq);
    if (!frame) {
      frame = {
        seq: packet.seq,
        timestampUs: packet.timestampUs,
        flags: packet.flags,
        totalChunks: packet.totalChunks,
        chunks: new Array(packet.totalChunks),
        receivedCount: 0,
        firstArrivalMs: now,
        lastArrivalMs: now,
      };
      pending.set(packet.seq, frame);
    }

    if (frame.totalChunks !== packet.totalChunks) {
      stats.packetsInvalid += 1;
      dropPendingFrame(frame, 'timeout');
      return;
    }

    if (frame.chunks[packet.chunkIndex]) {
      stats.packetsDuplicate += 1;
      return;
    }

    frame.chunks[packet.chunkIndex] = packet.payload;
    frame.receivedCount += 1;
    frame.lastArrivalMs = now;
    stats.packetsAccepted += 1;

    if (frame.receivedCount === frame.totalChunks) {
      finalizeFrame(frame);
    }
  };

  const cleanupPending = (): void => {
    const now = Date.now();
    for (const frame of Array.from(pending.values())) {
      if (frame.seq <= lastDeliveredSeq) {
        dropPendingFrame(frame, 'gap');
        continue;
      }
      if (now - frame.firstArrivalMs > config.maxFrameAgeMs) {
        dropPendingFrame(frame, 'timeout');
      }
    }

    if (pending.size > config.maxPendingFrames) {
      const bySeqAsc = Array.from(pending.values()).sort((a, b) => a.seq - b.seq);
      const needDrop = pending.size - config.maxPendingFrames;
      for (let i = 0; i < needDrop; i += 1) {
        const frame = bySeqAsc[i];
        if (!frame) break;
        dropPendingFrame(frame, 'queue');
      }
    }
  };

  socket.on('message', (datagram: Buffer, rinfo) => {
    if (stopRequested) return;
    stats.packetsReceived += 1;
    const packet = parseUdpPacket(datagram);
    if (!packet) {
      stats.packetsInvalid += 1;
      return;
    }
    handlePacket(packet, rinfo);
  });

  socket.on('error', (error) => {
    console.error(
      JSON.stringify({
        tag: 'host-daemon',
        event: 'udp_receiver_socket_error',
        message: error instanceof Error ? error.message : String(error ?? 'erro desconhecido'),
      }),
    );
    requestStop();
  });

  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject);
    socket.bind(config.listenPort, config.listenHost, () => {
      socket.off('error', reject);
      resolve();
    });
  });

  console.log(
    JSON.stringify({
      tag: 'host-daemon',
      event: 'udp_receiver_start',
      listenHost: config.listenHost,
      listenPort: config.listenPort,
      durationSec: config.durationSec,
      expectedStreamId: config.expectedStreamId ? streamIdToHex(config.expectedStreamId) : null,
      maxFrameAgeMs: config.maxFrameAgeMs,
      maxPendingFrames: config.maxPendingFrames,
      decoder: config.decoder,
      outputPath: config.outputPath ?? null,
      protocol: 'udp_h264_annexb_v1',
    }),
  );

  const cleanupTimer = setInterval(cleanupPending, 20);
  const statsTimer = setInterval(() => {
    stats.decodeFpsReported = decoder.getReportedFps();
    logReceiverStats(config, stats, pending.size, activeStreamId ? streamIdToHex(activeStreamId) : null);
  }, config.statsIntervalSec * 1000);
  const durationTimer = setTimeout(requestStop, config.durationSec * 1000);

  process.once('SIGINT', requestStop);
  process.once('SIGTERM', requestStop);

  await stopPromise;

  clearInterval(cleanupTimer);
  clearInterval(statsTimer);
  clearTimeout(durationTimer);

  for (const frame of Array.from(pending.values())) {
    dropPendingFrame(frame, 'timeout');
  }

  await writeChain.catch(() => undefined);
  await closeFile(outputStream);
  await decoder.close();

  socket.close();
  stats.decodeFpsReported = decoder.getReportedFps();

  logReceiverStats(config, stats, 0, activeStreamId ? streamIdToHex(activeStreamId) : null);
  console.log(
    JSON.stringify({
      tag: 'host-daemon',
      event: 'udp_receiver_summary',
      result: 'ok',
      streamId: activeStreamId ? streamIdToHex(activeStreamId) : null,
      remoteAddress: stats.remoteAddress,
      remotePort: stats.remotePort,
      packetsReceived: stats.packetsReceived,
      packetsAccepted: stats.packetsAccepted,
      packetsInvalid: stats.packetsInvalid,
      packetsDuplicate: stats.packetsDuplicate,
      packetsStreamMismatch: stats.packetsStreamMismatch,
      framesCompleted: stats.framesCompleted,
      framesDroppedTimeout: stats.framesDroppedTimeout,
      framesDroppedQueue: stats.framesDroppedQueue,
      framesDroppedLate: stats.framesDroppedLate,
      framesDroppedGap: stats.framesDroppedGap,
      seqGapFrames: stats.seqGapFrames,
      missingChunks: stats.missingChunks,
      jitterMs: Number(stats.jitterMs.toFixed(3)),
      decoderFramesFed: stats.decoderFramesFed,
      decoderWriteErrors: stats.decoderWriteErrors,
      durationSec: Number(((Date.now() - stats.startedAtMs) / 1000).toFixed(2)),
    }),
  );
}
