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
  const payload = {
    hostId: config.hostId,
    pcId: config.pcId ?? null,
    timestamp: new Date().toISOString(),
    version: config.version,
    status: config.status,
  };

  try {
    const response = await fetch(`${config.apiUrl}/hosts/${config.hostId}/heartbeat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-id': config.userId,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      console.error(`host-daemon: heartbeat falhou (${response.status}) ${text}`);
    }
  } catch (error) {
    console.error('host-daemon: erro ao enviar heartbeat', error);
  }
}

console.log(`host-daemon: iniciado (hostId=${config.hostId}, interval=${config.intervalMs}ms)`);

let interval: NodeJS.Timeout | null = null;

const start = () => {
  if (interval) return;
  sendHeartbeat();
  interval = setInterval(sendHeartbeat, config.intervalMs);
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
