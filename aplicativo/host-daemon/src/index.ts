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

const REQUEST_TIMEOUT_MS = Number(process.env.HEARTBEAT_REQUEST_TIMEOUT_MS ?? 5000);
const FAILURE_ALERT_THRESHOLD = Number(process.env.HEARTBEAT_FAILURE_ALERT_THRESHOLD ?? 3);

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

  const start = Date.now();
  const controller = new AbortController();
  let timeoutId: NodeJS.Timeout | null = null;
  try {
    timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const response = await fetch(`${config.apiUrl}/hosts/${config.hostId}/heartbeat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-id': config.userId,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
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
      if (!failureAlerted && heartbeatFailures >= FAILURE_ALERT_THRESHOLD) {
        failureAlerted = true;
        console.error(
          JSON.stringify({
            tag: 'host-daemon',
            event: 'heartbeat_alert',
            result: 'error',
            hostId: config.hostId,
            failures: heartbeatFailures,
            threshold: FAILURE_ALERT_THRESHOLD,
            lastStatusCode: response.status,
          }),
        );
      }
      return;
    }
    heartbeatFailures = 0;
    failureAlerted = false;
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
    const errorMessage =
      error && typeof error === 'object' && 'name' in error && error.name === 'AbortError'
        ? 'timeout'
        : error instanceof Error
          ? error.message
          : String(error ?? 'unknown');
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
        errorMessage,
        failures: heartbeatFailures,
      }),
    );
    if (!failureAlerted && heartbeatFailures >= FAILURE_ALERT_THRESHOLD) {
      failureAlerted = true;
      console.error(
        JSON.stringify({
          tag: 'host-daemon',
          event: 'heartbeat_alert',
          result: 'error',
          hostId: config.hostId,
          failures: heartbeatFailures,
          threshold: FAILURE_ALERT_THRESHOLD,
          lastStatusCode: 0,
          lastError: errorMessage,
        }),
      );
    }
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

console.log(`host-daemon: iniciado (hostId=${config.hostId}, interval=${config.intervalMs}ms)`);

let loopTimer: NodeJS.Timeout | null = null;
let watchdogTimer: NodeJS.Timeout | null = null;
let heartbeatSeq = 0;
let heartbeatFailures = 0;
let lastSentAt = 0;
let lastLoopAt = 0;
let failureAlerted = false;

const scheduleNext = (delayMs: number) => {
  if (loopTimer) {
    clearTimeout(loopTimer);
  }
  loopTimer = setTimeout(runLoop, delayMs);
};

const runLoop = async () => {
  lastLoopAt = Date.now();
  try {
    await sendHeartbeat();
  } catch (error) {
    console.error(
      JSON.stringify({
        tag: 'host-daemon',
        event: 'heartbeat_loop_error',
        hostId: config.hostId,
        errorMessage: error instanceof Error ? error.message : String(error ?? 'unknown'),
      }),
    );
  } finally {
    scheduleNext(config.intervalMs);
  }
};

const start = () => {
  if (loopTimer) return;
  runLoop();
  watchdogTimer = setInterval(() => {
    // Watchdog: se o loop travou por 2 ciclos, loga para diagnostico.
    const now = Date.now();
    if (lastLoopAt > 0 && now - lastLoopAt > config.intervalMs * 2) {
      console.warn(
        JSON.stringify({
          tag: 'host-daemon',
          event: 'heartbeat_watchdog',
          hostId: config.hostId,
          lastLoopAt: new Date(lastLoopAt).toISOString(),
          now: new Date(now).toISOString(),
          intervalMs: config.intervalMs,
        }),
      );
    }
  }, Math.max(1000, Math.floor(config.intervalMs / 2)));
};

const stop = () => {
  if (loopTimer) {
    clearTimeout(loopTimer);
    loopTimer = null;
  }
  if (watchdogTimer) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }
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
