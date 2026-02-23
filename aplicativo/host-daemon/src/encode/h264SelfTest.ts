import { createWriteStream, type WriteStream } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { once } from 'node:events';

import {
  createH264Encoder,
  type H264Encoder,
  type H264EncoderImplementation,
  type H264Profile,
  type RawFramePixelFormat,
  type RawVideoFrame,
} from './h264Encoder.js';

type ArgsMap = Map<string, string>;

type SelfTestConfig = {
  width: number;
  height: number;
  fps: number;
  durationSec: number;
  inputPixelFormat: RawFramePixelFormat;
  profile: H264Profile;
  bitrateKbps: number;
  keyframeInterval: number;
  ffmpegPath?: string;
  preferredEncoder: H264EncoderImplementation | 'auto';
  outputPath: string;
};

const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 720;
const DEFAULT_FPS = 30;
const DEFAULT_DURATION_SEC = 10;
const DEFAULT_BITRATE_KBPS = 6000;
const DEFAULT_PROFILE: H264Profile = 'baseline';

function parseNumber(value: string | undefined, fallback: number, min: number, max: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

function parsePixelFormat(value: string | undefined): RawFramePixelFormat {
  const normalized = (value ?? '').trim().toLowerCase();
  return normalized === 'rgba' ? 'rgba' : 'nv12';
}

function parseProfile(value: string | undefined): H264Profile {
  const normalized = (value ?? '').trim().toLowerCase();
  return normalized === 'main' ? 'main' : 'baseline';
}

function parsePreferredEncoder(value: string | undefined): H264EncoderImplementation | 'auto' {
  const normalized = (value ?? '').trim().toLowerCase();
  if (normalized === 'h264_nvenc') return 'h264_nvenc';
  if (normalized === 'h264_amf') return 'h264_amf';
  if (normalized === 'libx264') return 'libx264';
  if (normalized === 'libopenh264') return 'libopenh264';
  return 'auto';
}

function timestampLabel(now = new Date()): string {
  const yyyy = String(now.getFullYear());
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const mi = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  return `${yyyy}${mm}${dd}-${hh}${mi}${ss}`;
}

function buildConfig(args: ArgsMap): SelfTestConfig {
  const width = parseNumber(args.get('width'), DEFAULT_WIDTH, 64, 7680);
  const height = parseNumber(args.get('height'), DEFAULT_HEIGHT, 64, 4320);
  const fps = parseNumber(args.get('fps'), DEFAULT_FPS, 1, 240);
  const durationSec = parseNumber(args.get('duration-sec'), DEFAULT_DURATION_SEC, 1, 600);
  const bitrateKbps = parseNumber(args.get('bitrate-kbps'), DEFAULT_BITRATE_KBPS, 250, 200000);
  const keyframeInterval = parseNumber(args.get('keyint'), Math.max(1, fps * 2), 1, fps * 10);
  const inputPixelFormat = parsePixelFormat(args.get('pixel-format') ?? process.env.H264_INPUT_PIXFMT);
  const profile = parseProfile(args.get('profile') ?? process.env.H264_PROFILE);
  const preferredEncoder = parsePreferredEncoder(args.get('encoder') ?? process.env.H264_ENCODER);
  const ffmpegPath = args.get('ffmpeg-path') ?? process.env.FFMPEG_PATH;
  const outputArg = args.get('output');

  const outputPath = outputArg
    ? path.resolve(outputArg)
    : path.resolve(process.cwd(), `h264-selftest-${timestampLabel()}.h264`);

  return {
    width,
    height,
    fps,
    durationSec,
    inputPixelFormat,
    profile,
    bitrateKbps,
    keyframeInterval,
    ffmpegPath: ffmpegPath && ffmpegPath.trim() ? ffmpegPath.trim() : undefined,
    preferredEncoder,
    outputPath,
  };
}

function makeNv12Frame(width: number, height: number, frameIndex: number): Buffer {
  const yPlaneSize = width * height;
  const uvPlaneSize = Math.trunc(yPlaneSize / 2);
  const out = Buffer.allocUnsafe(yPlaneSize + uvPlaneSize);

  const yValue = 16 + ((frameIndex * 3) % 180);
  out.fill(yValue, 0, yPlaneSize);

  const uValue = 96 + ((frameIndex * 5) % 80);
  const vValue = 96 + ((frameIndex * 7) % 80);
  for (let i = yPlaneSize; i < yPlaneSize + uvPlaneSize; i += 2) {
    out[i] = uValue;
    out[i + 1] = vValue;
  }

  const boxW = Math.max(8, Math.min(96, Math.trunc(width * 0.1)));
  const boxH = Math.max(8, Math.min(96, Math.trunc(height * 0.1)));
  const maxX = Math.max(1, width - boxW - 1);
  const maxY = Math.max(1, height - boxH - 1);
  const offsetX = (frameIndex * 7) % maxX;
  const offsetY = (frameIndex * 5) % maxY;
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
      out[offset + 2] = ((x + y) + shift * 3) & 0xff;
      out[offset + 3] = 255;
      offset += 4;
    }
  }
  return out;
}

function makeFrame(config: SelfTestConfig, frameIndex: number): RawVideoFrame {
  const timestampUs = Date.now() * 1000;
  const data =
    config.inputPixelFormat === 'nv12'
      ? makeNv12Frame(config.width, config.height, frameIndex)
      : makeRgbaFrame(config.width, config.height, frameIndex);
  return {
    width: config.width,
    height: config.height,
    pixelFormat: config.inputPixelFormat,
    timestampUs,
    data,
  };
}

async function writeChunk(stream: WriteStream, bytes: Buffer): Promise<void> {
  const canWrite = stream.write(bytes);
  if (canWrite) return;
  await once(stream, 'drain');
}

async function closeWriteStream(stream: WriteStream): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    stream.end(() => resolve());
    stream.on('error', reject);
  });
}

export async function runH264SelfTest(args: ArgsMap): Promise<void> {
  const config = buildConfig(args);
  const encoder: H264Encoder = createH264Encoder({
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

  const selection = encoder.getSelection();
  const output = createWriteStream(config.outputPath);
  const totalFrames = config.fps * config.durationSec;
  const frameIntervalMs = 1000 / config.fps;
  const startedAtMs = Date.now();

  let framesIn = 0;
  let chunksOut = 0;
  let nalusOut = 0;
  let keyframes = 0;
  let spsPpsChunks = 0;
  let bytesOut = 0;

  console.log(
    JSON.stringify({
      tag: 'host-daemon',
      event: 'h264_selftest_start',
      width: config.width,
      height: config.height,
      fps: config.fps,
      durationSec: config.durationSec,
      inputPixelFormat: config.inputPixelFormat,
      profile: config.profile,
      bitrateKbps: config.bitrateKbps,
      keyframeInterval: config.keyframeInterval,
      encoder: selection.implementation,
      encoderReason: selection.reason,
      gpuVendor: selection.gpuVendor,
      outputPath: config.outputPath,
      annexB: true,
    }),
  );

  try {
    for (let i = 0; i < totalFrames; i += 1) {
      const plannedAt = startedAtMs + i * frameIntervalMs;
      const now = Date.now();
      if (plannedAt > now) {
        await new Promise<void>((resolve) => setTimeout(resolve, plannedAt - now));
      }

      const frame = makeFrame(config, i);
      const chunks = await encoder.encode(frame);
      framesIn += 1;

      for (const chunk of chunks) {
        await writeChunk(output, chunk.annexB);
        chunksOut += 1;
        nalusOut += chunk.nalus.length;
        bytesOut += chunk.annexB.length;
        if (chunk.isKeyframe) keyframes += 1;
        if (chunk.hasSps && chunk.hasPps) spsPpsChunks += 1;
      }
    }

    const trailing = await encoder.flush();
    for (const chunk of trailing) {
      await writeChunk(output, chunk.annexB);
      chunksOut += 1;
      nalusOut += chunk.nalus.length;
      bytesOut += chunk.annexB.length;
      if (chunk.isKeyframe) keyframes += 1;
      if (chunk.hasSps && chunk.hasPps) spsPpsChunks += 1;
    }
  } finally {
    await encoder.close().catch(() => undefined);
    await closeWriteStream(output).catch(() => undefined);
  }

  const elapsedSec = (Date.now() - startedAtMs) / 1000;
  const inputFps = elapsedSec > 0 ? framesIn / elapsedSec : 0;
  const bitrateOutKbps = elapsedSec > 0 ? (bytesOut * 8) / 1000 / elapsedSec : 0;

  console.log(
    JSON.stringify({
      tag: 'host-daemon',
      event: 'h264_selftest_summary',
      result: 'ok',
      encoder: selection.implementation,
      encoderReason: selection.reason,
      gpuVendor: selection.gpuVendor,
      framesIn,
      chunksOut,
      nalusOut,
      keyframes,
      spsPpsChunks,
      bytesOut,
      elapsedSec: Number(elapsedSec.toFixed(2)),
      inputFps: Number(inputFps.toFixed(2)),
      bitrateOutKbps: Number(bitrateOutKbps.toFixed(2)),
      outputPath: config.outputPath,
      playHint: `ffplay -fflags nobuffer -flags low_delay "${config.outputPath}"`,
    }),
  );
}
