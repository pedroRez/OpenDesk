import { useCallback, useEffect, useRef, useState } from 'react';
import type { UnlistenFn } from '@tauri-apps/api/event';

import { requestWithStatus } from '../lib/api';
import { isTauriRuntime } from '../lib/hostDaemon';
import {
  onLanInputError,
  onLanInputServerStats,
  onLanInputServerStatus,
  setLanInputServerSessionActive,
  startLanInputServer,
  stopLanInputServer,
  type LanInputServerStatsEvent,
} from '../lib/lanInput';

import styles from './HostLanInputPanel.module.css';

type HostLanInputPanelProps = {
  autoSessionActive: boolean;
  defaultSessionId?: string | null;
  defaultStreamId?: string | null;
};

type StreamStartSignalResponse = {
  sessionId: string;
  sessionStatus: 'PENDING' | 'ACTIVE' | 'ENDED' | 'FAILED';
  streamState: 'STARTING' | 'ACTIVE';
  host: string;
  videoPort: number;
  inputPort: number;
  streamId: string;
  token: string;
  tokenExpiresAt: string;
};

const DEFAULT_BIND_HOST = '0.0.0.0';
const DEFAULT_BIND_PORT = 5505;
const DEFAULT_EVENTS_PER_SEC = 700;
const DEFAULT_STATS_INTERVAL_MS = 1000;

function createInputToken(): string {
  if (typeof window !== 'undefined' && window.crypto?.getRandomValues) {
    const bytes = new Uint8Array(24);
    window.crypto.getRandomValues(bytes);
    return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
  }
  return `${Date.now().toString(16)}${Math.trunc(Math.random() * 1_000_000).toString(16)}`;
}

function formatNumber(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return '0';
  return value.toFixed(digits);
}

export default function HostLanInputPanel({
  autoSessionActive,
  defaultSessionId,
  defaultStreamId,
}: HostLanInputPanelProps) {
  const [bindHost, setBindHost] = useState(DEFAULT_BIND_HOST);
  const [bindPort, setBindPort] = useState(() => String(DEFAULT_BIND_PORT));
  const [authToken, setAuthToken] = useState(() => createInputToken());
  const [tokenExpiresAt, setTokenExpiresAt] = useState('');
  const [sessionId, setSessionId] = useState(defaultSessionId ?? '');
  const [streamId, setStreamId] = useState(defaultStreamId ?? '');
  const [maxEventsPerSecond, setMaxEventsPerSecond] = useState(() => String(DEFAULT_EVENTS_PER_SEC));
  const [statsIntervalMs, setStatsIntervalMs] = useState(() => String(DEFAULT_STATS_INTERVAL_MS));
  const [active, setActive] = useState(false);
  const [sessionActive, setSessionActive] = useState(autoSessionActive);
  const [status, setStatus] = useState('Servidor de input parado.');
  const [error, setError] = useState('');
  const [syncBusy, setSyncBusy] = useState(false);
  const [stats, setStats] = useState<LanInputServerStatsEvent | null>(null);
  const isAvailable = isTauriRuntime();
  const activeRef = useRef(false);

  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  useEffect(() => {
    if (!defaultSessionId) return;
    setSessionId((current) => (current.trim() ? current : defaultSessionId));
  }, [defaultSessionId]);

  useEffect(() => {
    if (!defaultStreamId) return;
    setStreamId((current) => (current.trim() ? current : defaultStreamId));
  }, [defaultStreamId]);

  const syncSessionCredentials = useCallback(
    async (sessionIdOverride?: string): Promise<StreamStartSignalResponse | null> => {
      const targetSessionId = (sessionIdOverride ?? sessionId).trim();
      if (!targetSessionId) {
        setError('Session ID obrigatorio para sincronizar credenciais.');
        return null;
      }

      setSyncBusy(true);
      setError('');
      try {
        const response = await requestWithStatus<StreamStartSignalResponse>(
          `/sessions/${targetSessionId}/stream/start`,
          {
            method: 'POST',
            body: JSON.stringify({}),
          },
        );
        if (!response.ok || !response.data) {
          setError(
            `Falha ao obter credenciais da sessao: ${
              response.errorMessage ?? `status ${response.status}`
            }`,
          );
          return null;
        }

        const signal = response.data;
        setSessionId(signal.sessionId);
        setStreamId(signal.streamId);
        setAuthToken(signal.token);
        setTokenExpiresAt(signal.tokenExpiresAt);
        setBindHost(signal.host || DEFAULT_BIND_HOST);
        if (signal.inputPort > 0) {
          setBindPort(String(signal.inputPort));
        }
        setStatus(
          `Credenciais sincronizadas para sessao ${signal.sessionId} (${signal.streamState}).`,
        );
        return signal;
      } finally {
        setSyncBusy(false);
      }
    },
    [sessionId],
  );

  useEffect(() => {
    setSessionActive(autoSessionActive);
    if (!isAvailable || !activeRef.current) return;

    if (!autoSessionActive) {
      stopLanInputServer()
        .then(() => {
          setActive(false);
          setStats(null);
          setStatus('Sessao finalizada. Servidor de input parado automaticamente.');
        })
        .catch((cause) => {
          setError(
            `Falha ao parar servidor de input no fim da sessao: ${
              cause instanceof Error ? cause.message : String(cause)
            }`,
          );
        });
      return;
    }

    setLanInputServerSessionActive(true).catch((cause) => {
      setError(
        `Falha ao sincronizar session ACTIVE: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      );
    });
  }, [autoSessionActive, isAvailable]);

  useEffect(() => {
    if (!isAvailable || !defaultSessionId || !autoSessionActive) return;
    syncSessionCredentials(defaultSessionId).catch((cause) => {
      setError(
        `Falha ao sincronizar credenciais automaticamente: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      );
    });
  }, [autoSessionActive, defaultSessionId, isAvailable, syncSessionCredentials]);

  useEffect(() => {
    if (!isAvailable) return;
    let stopped = false;
    const unlisteners: UnlistenFn[] = [];

    const setup = async () => {
      const unlistenStatus = await onLanInputServerStatus((event) => {
        if (stopped) return;
        setActive(event.active);
        setStatus(event.message);
        if (!event.active) {
          setStats(null);
        }
      });
      const unlistenStats = await onLanInputServerStats((event) => {
        if (stopped) return;
        setStats(event);
      });
      const unlistenError = await onLanInputError((event) => {
        if (stopped) return;
        setError(event.message);
      });
      unlisteners.push(unlistenStatus, unlistenStats, unlistenError);
    };

    setup().catch((cause) => {
      setError(
        `Falha ao registrar listeners do input LAN: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      );
    });

    return () => {
      stopped = true;
      for (const unlisten of unlisteners) {
        try {
          unlisten();
        } catch {
          // ignore unlisten failure
        }
      }
      if (activeRef.current) {
        stopLanInputServer().catch(() => undefined);
      }
    };
  }, [isAvailable]);

  const parsePort = useCallback((value: string): number | null => {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) {
      return null;
    }
    return parsed;
  }, []);

  const parsePositive = useCallback((value: string): number | null => {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return null;
    }
    return parsed;
  }, []);

  const startServer = useCallback(async () => {
    const normalizedHost = bindHost.trim() || DEFAULT_BIND_HOST;
    const normalizedToken = authToken.trim();
    const parsedPort = parsePort(bindPort);
    const parsedMaxEvents = parsePositive(maxEventsPerSecond);
    const parsedStatsInterval = parsePositive(statsIntervalMs);
    const parsedExpiresAtMs = tokenExpiresAt.trim()
      ? Date.parse(tokenExpiresAt.trim())
      : Number.NaN;
    const authExpiresAtMs = Number.isFinite(parsedExpiresAtMs)
      ? Math.trunc(parsedExpiresAtMs)
      : undefined;

    if (!parsedPort) {
      setError('Porta de bind invalida.');
      return;
    }
    if (!normalizedToken) {
      setError('Token de input obrigatorio.');
      return;
    }
    if (!parsedMaxEvents) {
      setError('Rate limit invalido.');
      return;
    }
    if (!parsedStatsInterval) {
      setError('Intervalo de metricas invalido.');
      return;
    }
    if (authExpiresAtMs && authExpiresAtMs <= Date.now()) {
      setError('Token de input expirado. Sincronize novamente a sessao.');
      return;
    }

    setError('');
    try {
      await startLanInputServer({
        bindHost: normalizedHost,
        bindPort: parsedPort,
        authToken: normalizedToken,
        authExpiresAtMs,
        sessionId: sessionId.trim() || undefined,
        streamId: streamId.trim() || undefined,
        sessionActive,
        maxEventsPerSecond: parsedMaxEvents,
        statsIntervalMs: parsedStatsInterval,
      });
      setActive(true);
      setStatus(`Servidor de input ativo em ${normalizedHost}:${parsedPort}.`);
    } catch (cause) {
      setError(
        `Falha ao iniciar servidor de input: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      );
    }
  }, [
    authToken,
    bindHost,
    bindPort,
    maxEventsPerSecond,
    parsePort,
    parsePositive,
    sessionActive,
    sessionId,
    statsIntervalMs,
    streamId,
    tokenExpiresAt,
  ]);

  const stopServer = useCallback(async () => {
    setError('');
    try {
      await stopLanInputServer();
      setActive(false);
      setStats(null);
      setStatus('Servidor de input parado.');
    } catch (cause) {
      setError(
        `Falha ao parar servidor de input: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      );
    }
  }, []);

  const toggleSessionActive = useCallback(async () => {
    if (!active) return;
    const next = !sessionActive;
    setError('');
    try {
      await setLanInputServerSessionActive(next);
      setSessionActive(next);
      setStatus(next ? 'Input habilitado para sessao ACTIVE.' : 'Input bloqueado (sessao INACTIVE).');
    } catch (cause) {
      setError(
        `Falha ao alterar session ACTIVE: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      );
    }
  }, [active, sessionActive]);

  if (!isAvailable) {
    return null;
  }

  const eventsDroppedTotal = (stats?.eventsDroppedInactive ?? 0) + (stats?.eventsDroppedRate ?? 0);
  const droppedPct = stats && stats.eventsReceived > 0 ? (eventsDroppedTotal / stats.eventsReceived) * 100 : 0;

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <h3>Servidor de Input LAN (TCP)</h3>
        <span className={`${styles.badge} ${active ? styles.badgeOn : styles.badgeOff}`}>
          {active ? 'ATIVO' : 'PARADO'}
        </span>
      </div>
      <p className={styles.description}>
        Canal dedicado de input cliente -&gt; host via TCP, separado do video UDP.
        Input so e aceito com token valido, nao expirado e sessao ACTIVE.
      </p>

      <div className={styles.grid}>
        <label>
          Bind host
          <input
            value={bindHost}
            onChange={(event) => setBindHost(event.target.value)}
            disabled={active}
            placeholder="0.0.0.0"
          />
        </label>
        <label>
          Bind port
          <input
            value={bindPort}
            onChange={(event) => setBindPort(event.target.value)}
            disabled={active}
            placeholder="5505"
          />
        </label>
        <label>
          Rate limit (events/s)
          <input
            value={maxEventsPerSecond}
            onChange={(event) => setMaxEventsPerSecond(event.target.value)}
            disabled={active}
            placeholder="700"
          />
        </label>
        <label>
          Stats interval (ms)
          <input
            value={statsIntervalMs}
            onChange={(event) => setStatsIntervalMs(event.target.value)}
            disabled={active}
            placeholder="1000"
          />
        </label>
        <label className={styles.spanTwo}>
          Token
          <input
            value={authToken}
            onChange={(event) => setAuthToken(event.target.value)}
            disabled={active}
            placeholder="token da sessao"
          />
        </label>
        <label>
          Token expiresAt (ISO)
          <input
            value={tokenExpiresAt}
            onChange={(event) => setTokenExpiresAt(event.target.value)}
            disabled={active}
            placeholder="2026-02-23T00:00:00.000Z"
          />
        </label>
        <label>
          Session ID
          <input
            value={sessionId}
            onChange={(event) => setSessionId(event.target.value)}
            disabled={active}
            placeholder="sessao ativa"
          />
        </label>
        <label>
          Stream ID
          <input
            value={streamId}
            onChange={(event) => setStreamId(event.target.value)}
            disabled={active}
            placeholder="stream filtrado"
          />
        </label>
      </div>

      <div className={styles.actions}>
        <button type="button" onClick={startServer} disabled={active || syncBusy}>
          Iniciar input
        </button>
        <button type="button" className={styles.ghost} onClick={stopServer} disabled={!active}>
          Parar input
        </button>
        <button
          type="button"
          className={styles.ghost}
          onClick={() => setAuthToken(createInputToken())}
          disabled={active}
        >
          Gerar token
        </button>
        <button
          type="button"
          className={styles.ghost}
          onClick={() => syncSessionCredentials()}
          disabled={active || syncBusy}
        >
          {syncBusy ? 'Sincronizando...' : 'Sincronizar sessao'}
        </button>
        <button type="button" className={styles.ghost} onClick={toggleSessionActive} disabled={!active}>
          Session ACTIVE: {sessionActive ? 'ON' : 'OFF'}
        </button>
      </div>

      <p className={styles.status}>{status}</p>
      {error && <p className={styles.error}>{error}</p>}

      <div className={styles.metrics}>
        <div>
          <strong>Clients auth:</strong> {stats?.authenticatedClients ?? 0}
        </div>
        <div>
          <strong>Auth fail:</strong> {stats?.authFailures ?? 0}
        </div>
        <div>
          <strong>Events recv:</strong> {stats?.eventsReceived ?? 0}
        </div>
        <div>
          <strong>Events inj:</strong> {stats?.eventsInjected ?? 0}
        </div>
        <div>
          <strong>Dropped rate:</strong> {stats?.eventsDroppedRate ?? 0}
        </div>
        <div>
          <strong>Dropped inactive:</strong> {stats?.eventsDroppedInactive ?? 0}
        </div>
        <div>
          <strong>Dropped %:</strong> {formatNumber(droppedPct)}%
        </div>
        <div>
          <strong>Inject errors:</strong> {stats?.injectErrors ?? 0}
        </div>
        <div>
          <strong>Mouse move:</strong> {stats?.mouseMoves ?? 0}
        </div>
        <div>
          <strong>Mouse buttons:</strong> {stats?.mouseButtons ?? 0}
        </div>
        <div>
          <strong>Mouse wheel:</strong> {stats?.mouseWheels ?? 0}
        </div>
        <div>
          <strong>Key events:</strong> {stats?.keyEvents ?? 0}
        </div>
      </div>
    </div>
  );
}
