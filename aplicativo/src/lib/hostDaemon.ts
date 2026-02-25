import { Command, type Child, type TerminatedPayload } from '@tauri-apps/plugin-shell';
import { resolveResource } from '@tauri-apps/api/path';

const DAEMON_RESOURCE = 'host-daemon/dist/index.js';
const DEFAULT_RELAY_DURATION_SEC = 36000;
const DEFAULT_RELAY_STATS_INTERVAL_SEC = 1;

type DaemonProcess = Child;

type RelayDaemonProcess = {
  managed: ManagedDaemonProcess;
  runtimeKey: string;
};

type DaemonKind = 'heartbeat' | 'relay-host';

type ManagedDaemonProcess = {
  child: DaemonProcess;
  command: Command<string>;
  kind: DaemonKind;
};

let heartbeatProcess: ManagedDaemonProcess | null = null;
let relayProcess: RelayDaemonProcess | null = null;

export type HostDaemonConfig = {
  apiUrl: string;
  userId: string;
  hostId: string;
  pcId?: string | null;
  version: string;
  intervalMs?: number;
};

export type HostRelayDaemonConfig = {
  relayUrl: string;
  sessionId: string;
  streamId: string;
  authToken: string;
  userId: string;
  authExpiresAtMs?: number;
  durationSec?: number;
  statsIntervalSec?: number;
};

export function isTauriRuntime(): boolean {
  if (typeof window === 'undefined') return false;
  const w = window as unknown as {
    __TAURI__?: unknown;
    __TAURI_INTERNALS__?: unknown;
    __TAURI_INVOKE__?: unknown;
  };
  return Boolean(w.__TAURI__ || w.__TAURI_INTERNALS__ || w.__TAURI_INVOKE__);
}

async function resolveEntryPath(): Promise<string> {
  const override = import.meta.env.VITE_HOST_DAEMON_ENTRY;
  if (override) return override;
  try {
    return await resolveResource(DAEMON_RESOURCE);
  } catch {
    return DAEMON_RESOURCE;
  }
}

type SpawnNodeDaemonOptions = {
  args: string[];
  kind: DaemonKind;
  onClose: (payload: TerminatedPayload) => void;
  onError: (error: string) => void;
};

type DaemonOutputPayload = string | Uint8Array;

function safeEventPayload(event: TerminatedPayload): { code: number | null; signal: number | null } {
  return {
    code: typeof event.code === 'number' ? event.code : null,
    signal: typeof event.signal === 'number' ? event.signal : null,
  };
}

function normalizeDaemonLine(chunk: DaemonOutputPayload): string {
  const raw = typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
  return raw.replace(/\r?\n$/, '').trim();
}

function logDaemonChunk(kind: DaemonKind, stream: 'stdout' | 'stderr', chunk: DaemonOutputPayload): void {
  const line = normalizeDaemonLine(chunk);
  if (!line) return;

  try {
    const parsed = JSON.parse(line);
    const base = `[HOST_DAEMON][${kind}][${stream}]`;
    if (stream === 'stderr') {
      console.error(base, parsed);
    } else {
      console.info(base, parsed);
    }
    return;
  } catch {
    // not json, keep plain text
  }

  const message = `[HOST_DAEMON][${kind}][${stream}] ${line}`;
  if (stream === 'stderr') {
    console.error(message);
  } else {
    console.info(message);
  }
}

async function spawnNodeDaemon(options: SpawnNodeDaemonOptions): Promise<ManagedDaemonProcess> {
  const { args, kind, onClose, onError } = options;
  const command = Command.create('node', args);
  command.stdout.on('data', (chunk) => {
    logDaemonChunk(kind, 'stdout', chunk);
  });
  command.stderr.on('data', (chunk) => {
    logDaemonChunk(kind, 'stderr', chunk);
  });
  command.on('close', (payload) => {
    const safePayload = safeEventPayload(payload);
    console.warn(
      `[HOST_DAEMON] processo encerrado (${kind})`,
      {
        code: safePayload.code,
        signal: safePayload.signal,
      },
    );
    onClose(payload);
  });
  command.on('error', (error) => {
    console.error(`[HOST_DAEMON] erro no processo (${kind})`, { error });
    onError(error);
  });

  const child = await command.spawn();
  console.info(`[HOST_DAEMON] processo iniciado (${kind})`, {
    pid: child.pid,
  });
  return {
    child,
    command,
    kind,
  };
}

export async function startHostDaemon(config: HostDaemonConfig): Promise<void> {
  if (!isTauriRuntime()) return;
  if (heartbeatProcess) return;

  const entry = await resolveEntryPath();
  const args = [
    entry,
    '--api-url',
    config.apiUrl,
    '--user-id',
    config.userId,
    '--host-id',
    config.hostId,
    '--version',
    config.version,
  ];

  if (config.pcId) {
    args.push('--pc-id', config.pcId);
  }
  if (config.intervalMs) {
    args.push('--interval-ms', String(config.intervalMs));
  }

  let spawnedPid: number | null = null;
  let processExitedEarly = false;
  const managed = await spawnNodeDaemon({
    args,
    kind: 'heartbeat',
    onClose: () => {
      processExitedEarly = true;
      if (spawnedPid !== null && heartbeatProcess?.child.pid === spawnedPid) {
        heartbeatProcess = null;
      }
    },
    onError: () => {
      processExitedEarly = true;
      if (spawnedPid !== null && heartbeatProcess?.child.pid === spawnedPid) {
        heartbeatProcess = null;
      }
    },
  });
  spawnedPid = managed.child.pid;
  heartbeatProcess = managed;
  if (processExitedEarly) {
    heartbeatProcess = null;
    console.warn('[HOST_DAEMON] processo heartbeat encerrou antes da registracao, marcando como STOPPED');
  }
}

export async function stopHostDaemon(): Promise<void> {
  if (!heartbeatProcess) return;
  try {
    await heartbeatProcess.child.kill();
  } finally {
    heartbeatProcess = null;
  }
}

export function getHostDaemonStatus(): 'RUNNING' | 'STOPPED' {
  return heartbeatProcess ? 'RUNNING' : 'STOPPED';
}

function normalizeRelayWebSocketUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) return trimmed;
  try {
    const url = new URL(trimmed);
    if (url.protocol === 'http:') {
      url.protocol = 'ws:';
    } else if (url.protocol === 'https:') {
      url.protocol = 'wss:';
    }
    return url.toString();
  } catch {
    return trimmed;
  }
}

function buildRelayRuntimeKey(config: HostRelayDaemonConfig): string {
  return [
    normalizeRelayWebSocketUrl(config.relayUrl),
    config.sessionId.trim(),
    config.streamId.trim().toLowerCase(),
    config.authToken.trim(),
    config.userId.trim(),
  ].join('|');
}

export async function startHostRelayDaemon(
  config: HostRelayDaemonConfig,
): Promise<'started' | 'restarted' | 'already_running'> {
  if (!isTauriRuntime()) {
    return 'already_running';
  }

  const relayUrl = normalizeRelayWebSocketUrl(config.relayUrl);
  const sessionId = config.sessionId.trim();
  const streamId = config.streamId.trim();
  const authToken = config.authToken.trim();
  const userId = config.userId.trim();

  if (!relayUrl) {
    throw new Error('relayUrl obrigatorio para iniciar relay-host.');
  }
  if (!sessionId) {
    throw new Error('sessionId obrigatorio para iniciar relay-host.');
  }
  if (!streamId) {
    throw new Error('streamId obrigatorio para iniciar relay-host.');
  }
  if (!authToken) {
    throw new Error('authToken obrigatorio para iniciar relay-host.');
  }
  if (!userId) {
    throw new Error('userId obrigatorio para iniciar relay-host.');
  }

  const runtimeKey = buildRelayRuntimeKey({
    ...config,
    relayUrl,
    sessionId,
    streamId,
    authToken,
    userId,
  });
  if (relayProcess?.runtimeKey === runtimeKey) {
    return 'already_running';
  }

  const hadRelayProcess = Boolean(relayProcess);
  if (relayProcess) {
    try {
      await relayProcess.managed.child.kill();
    } catch {
      // ignore process kill errors during restart
    } finally {
      relayProcess = null;
    }
  }

  const entry = await resolveEntryPath();
  const args = [
    entry,
    '--mode',
    'relay-host',
    '--relay-url',
    relayUrl,
    '--session-id',
    sessionId,
    '--user-id',
    userId,
    '--stream-id',
    streamId,
    '--auth-token',
    authToken,
    '--duration-sec',
    String(Math.max(1, Math.trunc(config.durationSec ?? DEFAULT_RELAY_DURATION_SEC))),
    '--stats-interval-sec',
    String(Math.max(1, Math.trunc(config.statsIntervalSec ?? DEFAULT_RELAY_STATS_INTERVAL_SEC))),
  ];

  if (typeof config.authExpiresAtMs === 'number' && Number.isFinite(config.authExpiresAtMs)) {
    args.push('--auth-expires-at-ms', String(Math.trunc(config.authExpiresAtMs)));
  }

  let spawnedPid: number | null = null;
  let processExitedEarly = false;
  const managed = await spawnNodeDaemon({
    args,
    kind: 'relay-host',
    onClose: () => {
      processExitedEarly = true;
      if (spawnedPid !== null && relayProcess?.managed.child.pid === spawnedPid) {
        relayProcess = null;
      }
    },
    onError: () => {
      processExitedEarly = true;
      if (spawnedPid !== null && relayProcess?.managed.child.pid === spawnedPid) {
        relayProcess = null;
      }
    },
  });
  spawnedPid = managed.child.pid;
  relayProcess = { managed, runtimeKey };
  if (processExitedEarly) {
    relayProcess = null;
    console.warn('[HOST_DAEMON] processo relay-host encerrou antes da registracao, marcando como STOPPED');
  }
  return hadRelayProcess ? 'restarted' : 'started';
}

export async function stopHostRelayDaemon(): Promise<void> {
  if (!relayProcess) return;
  try {
    await relayProcess.managed.child.kill();
  } finally {
    relayProcess = null;
  }
}

export function getHostRelayDaemonStatus(): 'RUNNING' | 'STOPPED' {
  return relayProcess ? 'RUNNING' : 'STOPPED';
}
