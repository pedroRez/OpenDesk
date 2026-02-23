import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

type ArgsMap = Map<string, string>;

type PixelFormat = 'nv12' | 'rgba';

type CaptureConfig = {
  ffmpegPath: string;
  fps: number;
  durationSec: number;
  width?: number;
  height?: number;
  outputIdx?: number;
  pixelFormat: PixelFormat;
  outputPath: string;
  stallTimeoutSec: number;
  openPreview: boolean;
  encoder: string;
};

type ProgressSnapshot = {
  frame: number;
  fpsReported: number;
  dropFrames: number;
  dupFrames: number;
  elapsedSec: number;
};

type AggregatedMetrics = {
  sampleCount: number;
  fpsSum: number;
  minFps: number;
  maxFps: number;
  lastFrame: number;
  lastDropFrames: number;
  lastDupFrames: number;
  firstSampleAtMs: number;
  lastSampleAtMs: number;
};

const DEFAULT_FPS = 30;
const DEFAULT_DURATION_SEC = 300;
const DEFAULT_STALL_TIMEOUT_SEC = 5;
const DEFAULT_FFMPEG_BIN = 'ffmpeg';

function parseNumber(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return value;
}

function parseIntSafe(raw: string | undefined): number | null {
  if (!raw) return null;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) return null;
  return value;
}

function parseFloatSafe(raw: string | undefined): number | null {
  if (!raw) return null;
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value)) return null;
  return value;
}

function parseBoolean(raw: string | undefined, fallback: boolean): boolean {
  if (!raw) return fallback;
  const normalized = raw.trim().toLowerCase();
  return ['1', 'true', 'yes', 'y', 'on'].includes(normalized);
}

function parsePixelFormat(raw: string | undefined): PixelFormat {
  const normalized = (raw ?? '').trim().toLowerCase();
  if (normalized === 'rgba') return 'rgba';
  return 'nv12';
}

function buildTimestampLabel(now = new Date()): string {
  const yyyy = String(now.getFullYear());
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const mi = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  return `${yyyy}${mm}${dd}-${hh}${mi}${ss}`;
}

function ensureWindows(): void {
  if (process.platform !== 'win32') {
    throw new Error('capture-preview disponivel apenas no Windows.');
  }
}

function ensureFfmpegAvailable(ffmpegPath: string): void {
  const probe = spawnSync(ffmpegPath, ['-version'], { encoding: 'utf8' });
  if (probe.error) {
    throw new Error(`ffmpeg nao encontrado (${ffmpegPath}). Erro: ${probe.error.message}`);
  }
  if (probe.status !== 0) {
    const detail = (probe.stderr || probe.stdout || '').trim();
    throw new Error(`falha ao executar ffmpeg (${ffmpegPath}). ${detail}`);
  }
}

function ensureDdaGrabFilter(ffmpegPath: string): void {
  const filters = spawnSync(ffmpegPath, ['-hide_banner', '-filters'], { encoding: 'utf8' });
  const text = `${filters.stdout ?? ''}\n${filters.stderr ?? ''}`;
  if (!/\bddagrab\b/i.test(text)) {
    throw new Error(
      'ffmpeg sem filtro ddagrab. Use um build com Desktop Duplication API (ex.: ffmpeg >= 6.x com ddagrab).',
    );
  }
}

function detectPreferredEncoder(ffmpegPath: string, requested?: string): string {
  if (requested && requested.trim()) return requested.trim();

  const encodersProbe = spawnSync(ffmpegPath, ['-hide_banner', '-encoders'], { encoding: 'utf8' });
  const text = `${encodersProbe.stdout ?? ''}\n${encodersProbe.stderr ?? ''}`;

  if (/\bh264_nvenc\b/i.test(text)) return 'h264_nvenc';
  if (/\blibx264\b/i.test(text)) return 'libx264';
  return 'mpeg4';
}

function buildConfig(args: ArgsMap): CaptureConfig {
  const ffmpegPath = args.get('ffmpeg-path') ?? process.env.FFMPEG_PATH ?? DEFAULT_FFMPEG_BIN;
  const fps = Math.max(1, Math.min(240, Math.trunc(parseNumber(args.get('fps'), DEFAULT_FPS))));
  const durationSec = Math.max(
    1,
    Math.min(3600, Math.trunc(parseNumber(args.get('duration-sec'), DEFAULT_DURATION_SEC))),
  );
  const width = parseIntSafe(args.get('width')) ?? undefined;
  const height = parseIntSafe(args.get('height')) ?? undefined;
  const outputIdx = parseIntSafe(args.get('output-idx')) ?? undefined;
  const pixelFormat = parsePixelFormat(args.get('pixel-format') ?? process.env.CAPTURE_PIXEL_FORMAT);
  const stallTimeoutSec = Math.max(
    2,
    Math.min(30, Math.trunc(parseNumber(args.get('stall-timeout-sec'), DEFAULT_STALL_TIMEOUT_SEC))),
  );
  const openPreview = parseBoolean(args.get('open-preview'), false);
  const requestedEncoder = args.get('encoder') ?? process.env.CAPTURE_ENCODER;
  const encoder = detectPreferredEncoder(ffmpegPath, requestedEncoder);

  const outputArg = args.get('output');
  const outputPath =
    outputArg && outputArg.trim()
      ? path.resolve(outputArg.trim())
      : path.resolve(process.cwd(), `capture-preview-${buildTimestampLabel()}.mp4`);

  return {
    ffmpegPath,
    fps,
    durationSec,
    width,
    height,
    outputIdx,
    pixelFormat,
    outputPath,
    stallTimeoutSec,
    openPreview,
    encoder,
  };
}

function buildInputSpec(config: CaptureConfig): string {
  const parts = [`framerate=${config.fps}`, 'draw_mouse=1'];
  if (typeof config.outputIdx === 'number' && Number.isFinite(config.outputIdx) && config.outputIdx >= 0) {
    parts.push(`output_idx=${Math.trunc(config.outputIdx)}`);
  }
  if (
    typeof config.width === 'number' &&
    Number.isFinite(config.width) &&
    config.width > 0 &&
    typeof config.height === 'number' &&
    Number.isFinite(config.height) &&
    config.height > 0
  ) {
    parts.push(`video_size=${Math.trunc(config.width)}x${Math.trunc(config.height)}`);
  }
  return `ddagrab=${parts.join(':')}`;
}

function buildFilterGraph(config: CaptureConfig): string {
  const filters: string[] = [`fps=${config.fps}`];
  if (
    typeof config.width === 'number' &&
    Number.isFinite(config.width) &&
    config.width > 0 &&
    typeof config.height === 'number' &&
    Number.isFinite(config.height) &&
    config.height > 0
  ) {
    filters.push(`scale=${Math.trunc(config.width)}:${Math.trunc(config.height)}:flags=bilinear`);
  }
  filters.push(`format=${config.pixelFormat}`);
  // Arquivo MP4 final deve ficar em formato amplamente compativel.
  filters.push('format=yuv420p');
  return filters.join(',');
}

function buildEncoderArgs(config: CaptureConfig): string[] {
  if (config.encoder === 'h264_nvenc') {
    return ['-c:v', 'h264_nvenc', '-preset', 'p4', '-tune', 'll', '-g', String(config.fps * 2)];
  }
  if (config.encoder === 'libx264') {
    return [
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-tune',
      'zerolatency',
      '-g',
      String(config.fps * 2),
      '-keyint_min',
      String(config.fps * 2),
      '-sc_threshold',
      '0',
    ];
  }
  return ['-c:v', 'mpeg4', '-q:v', '4', '-g', String(config.fps * 2)];
}

function buildFfmpegArgs(config: CaptureConfig): string[] {
  return [
    '-hide_banner',
    '-loglevel',
    'info',
    '-nostdin',
    '-stats_period',
    '1',
    '-progress',
    'pipe:1',
    '-f',
    'lavfi',
    '-i',
    buildInputSpec(config),
    '-an',
    '-vf',
    buildFilterGraph(config),
    '-r',
    String(config.fps),
    '-t',
    String(config.durationSec),
    ...buildEncoderArgs(config),
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    '-y',
    config.outputPath,
  ];
}

function createInitialMetrics(): AggregatedMetrics {
  return {
    sampleCount: 0,
    fpsSum: 0,
    minFps: Number.POSITIVE_INFINITY,
    maxFps: 0,
    lastFrame: 0,
    lastDropFrames: 0,
    lastDupFrames: 0,
    firstSampleAtMs: 0,
    lastSampleAtMs: 0,
  };
}

function parseOutTimeSec(progressMap: Record<string, string>): number {
  const outTimeUs = parseIntSafe(progressMap.out_time_us);
  if (outTimeUs && outTimeUs > 0) {
    return outTimeUs / 1_000_000;
  }

  // Em alguns builds, out_time_ms vem em micros apesar do nome.
  const outTimeMsRaw = parseIntSafe(progressMap.out_time_ms);
  if (outTimeMsRaw && outTimeMsRaw > 0) {
    if (outTimeMsRaw > 100_000) {
      return outTimeMsRaw / 1_000_000;
    }
    return outTimeMsRaw / 1_000;
  }

  const outTime = progressMap.out_time;
  if (!outTime) return 0;
  const [hh, mm, ss] = outTime.split(':');
  const seconds = Number(hh) * 3600 + Number(mm) * 60 + Number(ss);
  return Number.isFinite(seconds) ? seconds : 0;
}

function normalizeProgress(progressMap: Record<string, string>, startedAtMs: number): ProgressSnapshot {
  const frame = parseIntSafe(progressMap.frame) ?? 0;
  const fpsReported = parseFloatSafe(progressMap.fps) ?? 0;
  const dropFrames = parseIntSafe(progressMap.drop_frames) ?? 0;
  const dupFrames = parseIntSafe(progressMap.dup_frames) ?? 0;
  const elapsedByOutTime = parseOutTimeSec(progressMap);
  const elapsedByWallclock = (Date.now() - startedAtMs) / 1000;
  const elapsedSec = elapsedByOutTime > 0 ? elapsedByOutTime : elapsedByWallclock;

  return {
    frame,
    fpsReported,
    dropFrames,
    dupFrames,
    elapsedSec,
  };
}

function computeObservedFps(snapshot: ProgressSnapshot): number {
  if (snapshot.elapsedSec <= 0) return 0;
  return snapshot.frame / snapshot.elapsedSec;
}

function maybeOpenPreview(pathToFile: string): void {
  if (process.platform !== 'win32') return;
  const child = spawn('cmd', ['/c', 'start', '', pathToFile], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
}

export async function runCapturePreview(args: ArgsMap): Promise<void> {
  ensureWindows();
  const config = buildConfig(args);
  ensureFfmpegAvailable(config.ffmpegPath);
  ensureDdaGrabFilter(config.ffmpegPath);

  const ffmpegArgs = buildFfmpegArgs(config);
  console.log(
    JSON.stringify({
      tag: 'host-daemon',
      event: 'capture_start',
      method: 'desktop_duplication_api',
      ffmpegPath: config.ffmpegPath,
      encoder: config.encoder,
      fpsTarget: config.fps,
      durationSec: config.durationSec,
      pixelFormat: config.pixelFormat,
      width: config.width ?? null,
      height: config.height ?? null,
      outputPath: config.outputPath,
    }),
  );

  const metrics = createInitialMetrics();
  const startedAtMs = Date.now();
  let lastFrameAdvanceAtMs = startedAtMs;
  let stalled = false;
  let progressBuffer = '';
  let progressMap: Record<string, string> = {};
  let stderrTail = '';

  await new Promise<void>((resolve, reject) => {
    const child = spawn(config.ffmpegPath, ffmpegArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const watchdog = setInterval(() => {
      const now = Date.now();
      if (now - lastFrameAdvanceAtMs > config.stallTimeoutSec * 1000) {
        stalled = true;
        console.error(
          JSON.stringify({
            tag: 'host-daemon',
            event: 'capture_stall',
            sinceLastFrameMs: now - lastFrameAdvanceAtMs,
            stallTimeoutSec: config.stallTimeoutSec,
          }),
        );
        child.kill('SIGKILL');
      }
    }, 1000);

    child.stdout.on('data', (chunk: Buffer | string) => {
      progressBuffer += chunk.toString();
      while (true) {
        const breakIdx = progressBuffer.indexOf('\n');
        if (breakIdx < 0) break;
        const rawLine = progressBuffer.slice(0, breakIdx);
        progressBuffer = progressBuffer.slice(breakIdx + 1);
        const line = rawLine.trim();
        if (!line) continue;
        const eqIdx = line.indexOf('=');
        if (eqIdx <= 0) continue;
        const key = line.slice(0, eqIdx).trim();
        const value = line.slice(eqIdx + 1).trim();
        progressMap[key] = value;

        if (key !== 'progress') continue;

        const snapshot = normalizeProgress(progressMap, startedAtMs);
        const observedFps = computeObservedFps(snapshot);
        const now = Date.now();

        if (snapshot.frame > metrics.lastFrame) {
          lastFrameAdvanceAtMs = now;
        }

        metrics.sampleCount += 1;
        metrics.fpsSum += observedFps;
        metrics.minFps = Math.min(metrics.minFps, observedFps);
        metrics.maxFps = Math.max(metrics.maxFps, observedFps);
        metrics.lastFrame = snapshot.frame;
        metrics.lastDropFrames = snapshot.dropFrames;
        metrics.lastDupFrames = snapshot.dupFrames;
        metrics.firstSampleAtMs = metrics.firstSampleAtMs || now;
        metrics.lastSampleAtMs = now;

        console.log(
          JSON.stringify({
            tag: 'host-daemon',
            event: 'capture_progress',
            frame: snapshot.frame,
            fpsObserved: Number(observedFps.toFixed(2)),
            fpsReported: Number(snapshot.fpsReported.toFixed(2)),
            droppedFrames: snapshot.dropFrames,
            duplicatedFrames: snapshot.dupFrames,
            elapsedSec: Number(snapshot.elapsedSec.toFixed(2)),
            progress: value,
          }),
        );

        progressMap = {};
      }
    });

    child.stderr.on('data', (chunk: Buffer | string) => {
      const text = chunk.toString();
      stderrTail = `${stderrTail}\n${text}`;
      if (stderrTail.length > 4000) {
        stderrTail = stderrTail.slice(-4000);
      }
    });

    child.on('error', (error) => {
      clearInterval(watchdog);
      reject(error);
    });

    child.on('close', (code) => {
      clearInterval(watchdog);
      if (stalled) {
        reject(new Error('captura travou (sem novos frames dentro do timeout).'));
        return;
      }
      if (code !== 0) {
        reject(
          new Error(`ffmpeg encerrou com codigo ${code}. ${stderrTail.trim() || 'sem detalhe adicional.'}`),
        );
        return;
      }
      resolve();
    });
  });

  const elapsedTotalSec = (Date.now() - startedAtMs) / 1000;
  const avgFps = metrics.sampleCount > 0 ? metrics.fpsSum / metrics.sampleCount : 0;
  const expectedFrames = Math.max(1, Math.round(config.fps * config.durationSec));
  const estimatedDropped = Math.max(0, expectedFrames - metrics.lastFrame);
  const fpsThreshold = config.fps * 0.95;
  const meetsFpsThreshold = avgFps >= fpsThreshold;

  console.log(
    JSON.stringify({
      tag: 'host-daemon',
      event: 'capture_summary',
      result: 'ok',
      fpsTarget: config.fps,
      fpsAvg: Number(avgFps.toFixed(2)),
      fpsMin: Number((Number.isFinite(metrics.minFps) ? metrics.minFps : 0).toFixed(2)),
      fpsMax: Number(metrics.maxFps.toFixed(2)),
      framesCaptured: metrics.lastFrame,
      droppedFramesReported: metrics.lastDropFrames,
      droppedFramesEstimated: estimatedDropped,
      duplicatedFrames: metrics.lastDupFrames,
      elapsedSec: Number(elapsedTotalSec.toFixed(2)),
      outputPath: config.outputPath,
      encoder: config.encoder,
      pixelFormat: config.pixelFormat,
      meetsFpsThreshold: Number(avgFps.toFixed(2)) >= Number(fpsThreshold.toFixed(2)),
      stableAtTarget30Fps: config.fps === 30 && elapsedTotalSec >= 300 && !stalled && meetsFpsThreshold,
    }),
  );

  if (config.openPreview) {
    maybeOpenPreview(config.outputPath);
  }
}
