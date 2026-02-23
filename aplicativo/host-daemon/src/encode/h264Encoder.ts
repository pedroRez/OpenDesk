import { once } from 'node:events';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import process from 'node:process';

export type RawFramePixelFormat = 'nv12' | 'rgba';
export type H264Profile = 'baseline' | 'main';
export type H264EncoderImplementation = 'h264_nvenc' | 'h264_amf' | 'libx264' | 'libopenh264';
export type GpuVendor = 'nvidia' | 'amd' | 'intel' | 'unknown';

export type RawVideoFrame = {
  width: number;
  height: number;
  pixelFormat: RawFramePixelFormat;
  timestampUs: number;
  data: Buffer;
};

export type H264NaluChunk = {
  producedAtUs: number;
  naluTypes: number[];
  isKeyframe: boolean;
  hasSps: boolean;
  hasPps: boolean;
  annexB: Buffer;
  nalus: Buffer[];
};

export type H264EncoderSelection = {
  implementation: H264EncoderImplementation;
  gpuVendor: GpuVendor;
  gpuAdapters: string[];
  availableEncoders: H264EncoderImplementation[];
  reason: string;
  profile: H264Profile;
  bitrateKbps: number;
  keyframeInterval: number;
  annexB: true;
  periodicSpsPps: true;
};

export type H264EncoderInit = {
  width: number;
  height: number;
  fps: number;
  inputPixelFormat: RawFramePixelFormat;
  profile?: H264Profile;
  bitrateKbps?: number;
  keyframeInterval?: number;
  ffmpegPath?: string;
  preferredEncoder?: H264EncoderImplementation | 'auto';
  outputWaitMs?: number;
};

export interface H264Encoder {
  encode(frame: RawVideoFrame): Promise<H264NaluChunk[]>;
  flush(): Promise<H264NaluChunk[]>;
  close(): Promise<void>;
  getSelection(): H264EncoderSelection;
}

type StartCode = { index: number; length: number };

const DEFAULT_FFMPEG_PATH = 'ffmpeg';
const DEFAULT_BITRATE_KBPS = 6000;
const DEFAULT_OUTPUT_WAIT_MS = 25;
const CLOSE_TIMEOUT_MS = 2000;
const FLUSH_TIMEOUT_MS = 2000;

function parseGpuLines(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => line.toLowerCase() !== 'name');
}

function queryGpuAdaptersWindows(): string[] {
  const wmic = spawnSync('wmic', ['path', 'win32_VideoController', 'get', 'name'], {
    encoding: 'utf8',
  });
  if (!wmic.error && wmic.status === 0) {
    const parsed = parseGpuLines(`${wmic.stdout ?? ''}`);
    if (parsed.length > 0) return parsed;
  }

  const powershell = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      '(Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name)',
    ],
    { encoding: 'utf8' },
  );
  if (!powershell.error && powershell.status === 0) {
    const parsed = parseGpuLines(`${powershell.stdout ?? ''}`);
    if (parsed.length > 0) return parsed;
  }

  return [];
}

function detectGpuVendor(adapters: string[]): GpuVendor {
  const joined = adapters.join(' | ').toLowerCase();
  if (!joined) return 'unknown';
  if (joined.includes('nvidia')) return 'nvidia';
  if (joined.includes('amd') || joined.includes('radeon')) return 'amd';
  if (joined.includes('intel')) return 'intel';
  return 'unknown';
}

function assertFfmpegAvailable(ffmpegPath: string): void {
  const probe = spawnSync(ffmpegPath, ['-version'], { encoding: 'utf8' });
  if (probe.error) {
    throw new Error(`ffmpeg nao encontrado (${ffmpegPath}). ${probe.error.message}`);
  }
  if (probe.status !== 0) {
    throw new Error(`falha ao executar ffmpeg (${ffmpegPath}). ${(probe.stderr ?? probe.stdout ?? '').trim()}`);
  }
}

function listAvailableEncoders(ffmpegPath: string): H264EncoderImplementation[] {
  const probe = spawnSync(ffmpegPath, ['-hide_banner', '-encoders'], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0) {
    throw new Error(`falha ao listar encoders do ffmpeg (${ffmpegPath}).`);
  }

  const text = `${probe.stdout ?? ''}\n${probe.stderr ?? ''}`.toLowerCase();
  const ordered: H264EncoderImplementation[] = ['h264_nvenc', 'h264_amf', 'libx264', 'libopenh264'];
  return ordered.filter((name) => text.includes(name));
}

function resolveEncoderSelection(init: H264EncoderInit): H264EncoderSelection {
  const ffmpegPath = init.ffmpegPath ?? process.env.FFMPEG_PATH ?? DEFAULT_FFMPEG_PATH;
  assertFfmpegAvailable(ffmpegPath);

  const availableEncoders = listAvailableEncoders(ffmpegPath);
  if (availableEncoders.length === 0) {
    throw new Error('nenhum encoder H.264 suportado encontrado (nvenc/amf/libx264/libopenh264).');
  }

  const adapters = process.platform === 'win32' ? queryGpuAdaptersWindows() : [];
  const gpuVendor = detectGpuVendor(adapters);

  const preferred = init.preferredEncoder ?? 'auto';
  if (preferred !== 'auto') {
    if (!availableEncoders.includes(preferred)) {
      throw new Error(`encoder solicitado "${preferred}" nao disponivel neste ffmpeg.`);
    }
    return {
      implementation: preferred,
      gpuVendor,
      gpuAdapters: adapters,
      availableEncoders,
      reason: 'manual',
      profile: init.profile ?? 'baseline',
      bitrateKbps: init.bitrateKbps ?? DEFAULT_BITRATE_KBPS,
      keyframeInterval: init.keyframeInterval ?? Math.max(1, Math.trunc(init.fps * 2)),
      annexB: true,
      periodicSpsPps: true,
    };
  }

  const softwareFallbackOrder: H264EncoderImplementation[] = ['libx264', 'libopenh264'];
  const tryHardware: H264EncoderImplementation[] =
    gpuVendor === 'nvidia' ? ['h264_nvenc'] : gpuVendor === 'amd' ? ['h264_amf'] : [];
  const order: H264EncoderImplementation[] = [...tryHardware, ...softwareFallbackOrder];
  const selected = order.find((name) => availableEncoders.includes(name)) ?? availableEncoders[0];

  const reason =
    tryHardware.includes(selected) ? `auto_${gpuVendor}` : `auto_software_fallback_from_${gpuVendor}`;

  return {
    implementation: selected,
    gpuVendor,
    gpuAdapters: adapters,
    availableEncoders,
    reason,
    profile: init.profile ?? 'baseline',
    bitrateKbps: init.bitrateKbps ?? DEFAULT_BITRATE_KBPS,
    keyframeInterval: init.keyframeInterval ?? Math.max(1, Math.trunc(init.fps * 2)),
    annexB: true,
    periodicSpsPps: true,
  };
}

function findStartCode(buffer: Buffer, fromIndex: number): StartCode | null {
  for (let i = fromIndex; i < buffer.length - 3; i += 1) {
    if (buffer[i] !== 0 || buffer[i + 1] !== 0) continue;
    if (buffer[i + 2] === 1) return { index: i, length: 3 };
    if (i + 3 < buffer.length && buffer[i + 2] === 0 && buffer[i + 3] === 1) {
      return { index: i, length: 4 };
    }
  }
  return null;
}

function parseAnnexBNalus(input: Buffer, flushTail: boolean): { nalus: Buffer[]; remainder: Buffer } {
  const starts: StartCode[] = [];
  let cursor = 0;
  while (true) {
    const match = findStartCode(input, cursor);
    if (!match) break;
    starts.push(match);
    cursor = match.index + match.length;
  }

  if (starts.length === 0) {
    return {
      nalus: [],
      remainder: flushTail ? Buffer.alloc(0) : input,
    };
  }

  const nalus: Buffer[] = [];
  for (let i = 0; i < starts.length; i += 1) {
    const bodyStart = starts[i].index + starts[i].length;
    const bodyEnd = i + 1 < starts.length ? starts[i + 1].index : flushTail ? input.length : -1;
    if (bodyEnd < 0) break;
    if (bodyEnd <= bodyStart) continue;
    nalus.push(Buffer.from(input.subarray(bodyStart, bodyEnd)));
  }

  return {
    nalus,
    remainder: flushTail ? Buffer.alloc(0) : Buffer.from(input.subarray(starts[starts.length - 1].index)),
  };
}

function buildAnnexB(nalus: Buffer[]): Buffer {
  const startCodeSize = 4;
  const total = nalus.reduce((sum, nalu) => sum + startCodeSize + nalu.length, 0);
  const out = Buffer.allocUnsafe(total);
  let offset = 0;
  for (const nalu of nalus) {
    out[offset] = 0;
    out[offset + 1] = 0;
    out[offset + 2] = 0;
    out[offset + 3] = 1;
    offset += 4;
    nalu.copy(out, offset);
    offset += nalu.length;
  }
  return out;
}

function parseNaluTypes(nalus: Buffer[]): number[] {
  return nalus
    .map((nalu) => (nalu.length > 0 ? nalu[0] & 0x1f : 0))
    .filter((nalType) => nalType > 0);
}

function frameByteLength(width: number, height: number, pixelFormat: RawFramePixelFormat): number {
  const area = width * height;
  if (pixelFormat === 'rgba') return area * 4;
  return Math.trunc((area * 3) / 2);
}

function buildFfmpegArgs(init: H264EncoderInit, selection: H264EncoderSelection): string[] {
  const bitrateKbps = selection.bitrateKbps;
  const keyint = Math.max(1, selection.keyframeInterval);
  const profile = selection.profile;
  const bitrate = `${bitrateKbps}k`;
  const maxrate = `${Math.round(bitrateKbps * 1.15)}k`;
  const bufsize = `${Math.max(300, Math.round(bitrateKbps * 0.6))}k`;

  const args: string[] = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostdin',
    '-fflags',
    'nobuffer',
    '-f',
    'rawvideo',
    '-pix_fmt',
    init.inputPixelFormat,
    '-s:v',
    `${init.width}x${init.height}`,
    '-r',
    String(init.fps),
    '-i',
    'pipe:0',
    '-an',
    '-c:v',
    selection.implementation,
    '-profile:v',
    profile,
    '-b:v',
    bitrate,
    '-maxrate',
    maxrate,
    '-bufsize',
    bufsize,
    '-g',
    String(keyint),
    '-keyint_min',
    String(keyint),
    '-sc_threshold',
    '0',
    '-bf',
    '0',
    '-flags:v',
    '+low_delay',
  ];

  if (selection.implementation === 'h264_nvenc') {
    args.push('-preset', 'p4', '-tune', 'll');
  } else if (selection.implementation === 'h264_amf') {
    args.push('-usage', 'lowlatency');
  } else if (selection.implementation === 'libx264') {
    args.push(
      '-preset',
      'veryfast',
      '-tune',
      'zerolatency',
      '-x264-params',
      `repeat-headers=1:keyint=${keyint}:min-keyint=${keyint}:scenecut=0`,
    );
  }

  // Annex B elementary stream + periodic SPS/PPS injection at keyframes.
  args.push('-bsf:v', 'dump_extra=freq=keyframe', '-f', 'h264', 'pipe:1');
  return args;
}

class FfmpegH264Encoder implements H264Encoder {
  private readonly init: H264EncoderInit;
  private readonly selection: H264EncoderSelection;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly expectedBytes: number;
  private readonly outputWaitMs: number;
  private readonly waiters = new Set<() => void>();
  private readonly chunkQueue: H264NaluChunk[] = [];
  private parserRemainder: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private closed = false;
  private closeError: Error | null = null;
  private writeChain: Promise<unknown> = Promise.resolve();

  constructor(init: H264EncoderInit, selection: H264EncoderSelection, child: ChildProcessWithoutNullStreams) {
    this.init = init;
    this.selection = selection;
    this.child = child;
    this.expectedBytes = frameByteLength(init.width, init.height, init.inputPixelFormat);
    this.outputWaitMs = Math.max(1, init.outputWaitMs ?? DEFAULT_OUTPUT_WAIT_MS);
    this.bindEvents();
  }

  static create(init: H264EncoderInit): FfmpegH264Encoder {
    if (!Number.isFinite(init.width) || init.width <= 0 || !Number.isFinite(init.height) || init.height <= 0) {
      throw new Error('width/height invalidos para encoder H.264.');
    }
    if (!Number.isFinite(init.fps) || init.fps <= 0) {
      throw new Error('fps invalido para encoder H.264.');
    }

    const ffmpegPath = init.ffmpegPath ?? process.env.FFMPEG_PATH ?? DEFAULT_FFMPEG_PATH;
    const normalized: H264EncoderInit = {
      ...init,
      ffmpegPath,
      profile: init.profile ?? 'baseline',
      bitrateKbps: init.bitrateKbps ?? DEFAULT_BITRATE_KBPS,
      keyframeInterval: init.keyframeInterval ?? Math.max(1, Math.trunc(init.fps * 2)),
      preferredEncoder: init.preferredEncoder ?? 'auto',
      outputWaitMs: init.outputWaitMs ?? DEFAULT_OUTPUT_WAIT_MS,
    };
    const selection = resolveEncoderSelection(normalized);
    const args = buildFfmpegArgs(normalized, selection);

    const child = spawn(ffmpegPath, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    if (!child.stdin || !child.stdout || !child.stderr) {
      throw new Error('falha ao inicializar pipes do processo ffmpeg.');
    }

    return new FfmpegH264Encoder(normalized, selection, child);
  }

  getSelection(): H264EncoderSelection {
    return this.selection;
  }

  encode(frame: RawVideoFrame): Promise<H264NaluChunk[]> {
    const job = this.writeChain.then(async () => this.encodeInternal(frame));
    this.writeChain = job.then(
      () => undefined,
      () => undefined,
    );
    return job;
  }

  async flush(): Promise<H264NaluChunk[]> {
    if (this.closed) return this.drainChunks();

    try {
      this.child.stdin.end();
    } catch {
      // Ignore, process may already be shutting down.
    }

    await Promise.race([
      once(this.child, 'close'),
      new Promise<void>((resolve) => setTimeout(resolve, FLUSH_TIMEOUT_MS)),
    ]).catch(() => undefined);

    this.consumeParserBuffer(true);
    return this.drainChunks();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    try {
      this.child.stdin.destroy();
    } catch {
      // ignore
    }

    if (!this.child.killed) {
      this.child.kill('SIGKILL');
    }

    await Promise.race([
      once(this.child, 'close'),
      new Promise<void>((resolve) => setTimeout(resolve, CLOSE_TIMEOUT_MS)),
    ]).catch(() => undefined);
  }

  private async encodeInternal(frame: RawVideoFrame): Promise<H264NaluChunk[]> {
    this.ensureWritable();
    this.validateFrame(frame);

    const canWrite = this.child.stdin.write(frame.data);
    if (!canWrite) {
      await once(this.child.stdin, 'drain');
    }

    await this.waitForOutputOrTimeout();
    return this.drainChunks();
  }

  private ensureWritable(): void {
    if (this.closed) {
      throw this.closeError ?? new Error('encoder H.264 ja encerrado.');
    }
    if (!this.child.stdin.writable) {
      throw this.closeError ?? new Error('stdin do ffmpeg nao esta mais gravavel.');
    }
  }

  private validateFrame(frame: RawVideoFrame): void {
    if (frame.width !== this.init.width || frame.height !== this.init.height) {
      throw new Error(
        `frame ${frame.width}x${frame.height} difere da sessao ${this.init.width}x${this.init.height}.`,
      );
    }
    if (frame.pixelFormat !== this.init.inputPixelFormat) {
      throw new Error(`pixelFormat "${frame.pixelFormat}" difere da sessao "${this.init.inputPixelFormat}".`);
    }
    if (!Buffer.isBuffer(frame.data)) {
      throw new Error('frame.data deve ser Buffer.');
    }
    if (frame.data.length !== this.expectedBytes) {
      throw new Error(`tamanho do frame invalido. esperado=${this.expectedBytes}, recebido=${frame.data.length}.`);
    }
  }

  private bindEvents(): void {
    this.child.stdout.on('data', (chunk: Buffer | string) => {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (data.length === 0) return;
      this.parserRemainder = Buffer.concat([this.parserRemainder, data]);
      this.consumeParserBuffer(false);
      this.notifyWaiters();
    });

    this.child.stderr.on('data', (chunk: Buffer | string) => {
      const text = chunk.toString().trim();
      if (!text) return;
      console.warn(JSON.stringify({ tag: 'host-daemon', event: 'h264_encoder_stderr', message: text }));
    });

    this.child.stdin.on('error', (error) => {
      this.closeError = error instanceof Error ? error : new Error(String(error));
      this.notifyWaiters();
    });

    this.child.on('error', (error) => {
      this.closeError = error instanceof Error ? error : new Error(String(error));
      this.closed = true;
      this.notifyWaiters();
    });

    this.child.on('close', (code, signal) => {
      this.consumeParserBuffer(true);
      this.closed = true;
      if (!this.closeError && code !== 0) {
        this.closeError = new Error(`ffmpeg encerrou com code=${code ?? 'null'} signal=${signal ?? 'null'}`);
      }
      this.notifyWaiters();
    });
  }

  private consumeParserBuffer(flushTail: boolean): void {
    const parsed = parseAnnexBNalus(this.parserRemainder, flushTail);
    this.parserRemainder = parsed.remainder as Buffer;
    if (parsed.nalus.length === 0) return;

    const naluTypes = parseNaluTypes(parsed.nalus);
    const chunk: H264NaluChunk = {
      producedAtUs: Date.now() * 1000,
      naluTypes,
      isKeyframe: naluTypes.includes(5),
      hasSps: naluTypes.includes(7),
      hasPps: naluTypes.includes(8),
      annexB: buildAnnexB(parsed.nalus),
      nalus: parsed.nalus.map((nalu) => Buffer.from(nalu)),
    };
    this.chunkQueue.push(chunk);
  }

  private drainChunks(): H264NaluChunk[] {
    if (this.chunkQueue.length === 0) return [];
    const out = this.chunkQueue.slice();
    this.chunkQueue.length = 0;
    return out;
  }

  private async waitForOutputOrTimeout(): Promise<void> {
    if (this.chunkQueue.length > 0 || this.closed) return;

    await new Promise<void>((resolve) => {
      const onReady = () => {
        this.waiters.delete(onReady);
        clearTimeout(timer);
        resolve();
      };

      const timer = setTimeout(() => {
        this.waiters.delete(onReady);
        resolve();
      }, this.outputWaitMs);

      this.waiters.add(onReady);
    });
  }

  private notifyWaiters(): void {
    for (const waiter of this.waiters) {
      waiter();
    }
  }
}

export function createH264Encoder(init: H264EncoderInit): H264Encoder {
  return FfmpegH264Encoder.create(init);
}
