import process from 'node:process';

const ARG_PREFIX = '--';

type Config = {
  apiUrl: string;
  userId: string;
  hostId: string;
  pcId?: string | null;
  version: string;
  intervalMs: number;
  status?: 'ONLINE' | 'OFFLINE' | 'BUSY';
};

function parseArgs() {
  const args = process.argv.slice(2);
  const map = new Map<string, string>();
  for (let i = 0; i < args.length; i += 1) {
    const raw = args[i];
    if (!raw.startsWith(ARG_PREFIX)) continue;
    const key = raw.slice(ARG_PREFIX.length);
    const value = args[i + 1];
    if (!value || value.startsWith(ARG_PREFIX)) continue;
    map.set(key, value);
    i += 1;
  }
  return map;
}

async function getFetch() {
  if (globalThis.fetch) return globalThis.fetch.bind(globalThis);
  const mod = await import('node-fetch');
  return (mod.default as unknown as typeof fetch).bind(globalThis);
}

const args = parseArgs();
const rawInterval = Number(
  args.get('interval-ms') ?? process.env.HEARTBEAT_INTERVAL_MS ?? '10000',
);
const intervalMs = Number.isFinite(rawInterval) ? rawInterval : 10000;

const config: Config = {
  apiUrl: args.get('api-url') ?? process.env.API_URL ?? 'http://localhost:3333',
  userId: args.get('user-id') ?? process.env.USER_ID ?? '',
  hostId: args.get('host-id') ?? process.env.HOST_ID ?? '',
  pcId: args.get('pc-id') ?? process.env.PC_ID ?? null,
  version: args.get('version') ?? process.env.DAEMON_VERSION ?? '0.1.0',
  intervalMs,
  status: (args.get('status') ?? process.env.HEARTBEAT_STATUS ?? undefined) as
    | 'ONLINE'
    | 'OFFLINE'
    | 'BUSY'
    | undefined,
};

if (!config.userId || !config.hostId) {
  console.error('host-daemon: userId e hostId sao obrigatorios.');
  process.exit(1);
}

async function sendHeartbeat() {
  const fetch = await getFetch();
  const now = Date.now();
  const seq = ++heartbeatSeq;
  const sentAt = new Date(now).toISOString();
  lastSentAt = now;
  const payload = {
    hostId: config.hostId,
    pcId: config.pcId ?? null,
    timestamp: sentAt,
    version: config.version,
    status: config.status,
    intervalMs: config.intervalMs,
    seq,
    sentAt,
  };

  try {
    const start = Date.now();
    const response = await fetch(`${config.apiUrl}/hosts/${config.hostId}/heartbeat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-id': config.userId,
      },
      body: JSON.stringify(payload),
    });

    const durationMs = Date.now() - start;
    lastSentAt = now;
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      heartbeatFailures += 1;
      console.error(
        JSON.stringify({
          tag: 'host-daemon',
          event: 'heartbeat',
          result: 'error',
          hostId: config.hostId,
          seq,
          sentAt,
          durationMs,
          statusCode: response.status,
          errorMessage: text,
          failures: heartbeatFailures,
        }),
      );
      return;
    }
    heartbeatFailures = 0;
    console.log(
      JSON.stringify({
        tag: 'host-daemon',
        event: 'heartbeat',
        result: 'ok',
        hostId: config.hostId,
        seq,
        sentAt,
        durationMs,
        statusCode: response.status,
      }),
    );
  } catch (error) {
    const durationMs = Date.now() - now;
    heartbeatFailures += 1;
    console.error(
      JSON.stringify({
        tag: 'host-daemon',
        event: 'heartbeat',
        result: 'error',
        hostId: config.hostId,
        seq,
        sentAt,
        durationMs,
        statusCode: 0,
        errorMessage: error instanceof Error ? error.message : String(error ?? 'unknown'),
        failures: heartbeatFailures,
      }),
    );
  }
}

console.log(`host-daemon: iniciado (hostId=${config.hostId}, interval=${config.intervalMs}ms)`);

let interval: NodeJS.Timeout | null = null;
let heartbeatSeq = 0;
let heartbeatFailures = 0;
let lastSentAt = 0;

const start = () => {
  if (interval) return;
  sendHeartbeat();
  interval = setInterval(() => {
    // Watchdog: se nao conseguimos enviar por 2 ciclos, loga para diagnostico.
    const now = Date.now();
    if (lastSentAt > 0 && now - lastSentAt > config.intervalMs * 2) {
      console.warn(
        JSON.stringify({
          tag: 'host-daemon',
          event: 'heartbeat_watchdog',
          hostId: config.hostId,
          lastSentAt: new Date(lastSentAt).toISOString(),
          now: new Date(now).toISOString(),
          intervalMs: config.intervalMs,
        }),
      );
    }
    sendHeartbeat();
  }, config.intervalMs);
};

const stop = () => {
  if (!interval) return;
  clearInterval(interval);
  interval = null;
};

process.on('SIGINT', () => {
  stop();
  process.exit(0);
});

process.on('SIGTERM', () => {
  stop();
  process.exit(0);
});

start();
