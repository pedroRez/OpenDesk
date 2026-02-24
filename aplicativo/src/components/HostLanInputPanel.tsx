import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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

  type StartServerOverrides = {
    bindHost?: string;
    bindPort?: number;
    authToken?: string;
    tokenExpiresAt?: string;
    sessionId?: string;
    streamId?: string;
    sessionActive?: boolean;
  };

  const startServer = useCallback(async (
    overrides?: StartServerOverrides,
    options?: { auto?: boolean; restartIfActive?: boolean },
  ): Promise<boolean> => {
    const normalizedHost = (overrides?.bindHost ?? bindHost).trim() || DEFAULT_BIND_HOST;
    const normalizedToken = (overrides?.authToken ?? authToken).trim();
    const parsedPort = overrides?.bindPort ?? parsePort(bindPort);
    const parsedMaxEvents = parsePositive(maxEventsPerSecond) ?? DEFAULT_EVENTS_PER_SEC;
    const parsedStatsInterval = parsePositive(statsIntervalMs) ?? DEFAULT_STATS_INTERVAL_MS;
    const effectiveTokenExpiresAt = (overrides?.tokenExpiresAt ?? tokenExpiresAt).trim();
    const parsedExpiresAtMs = effectiveTokenExpiresAt ? Date.parse(effectiveTokenExpiresAt) : Number.NaN;
    const authExpiresAtMs = Number.isFinite(parsedExpiresAtMs)
      ? Math.trunc(parsedExpiresAtMs)
      : undefined;

    if (!parsedPort) {
      setError('Porta de bind invalida.');
      return false;
    }
    if (!normalizedToken) {
      setError('Token de input obrigatorio.');
      return false;
    }
    if (authExpiresAtMs && authExpiresAtMs <= Date.now()) {
      setError('Token de input expirado. Sincronize novamente a sessao.');
      return false;
    }

    setError('');
    try {
      if (options?.restartIfActive && activeRef.current) {
        await stopLanInputServer();
        setActive(false);
        setStats(null);
      }

      await startLanInputServer({
        bindHost: normalizedHost,
        bindPort: parsedPort,
        authToken: normalizedToken,
        authExpiresAtMs,
        sessionId: (overrides?.sessionId ?? sessionId).trim() || undefined,
        streamId: (overrides?.streamId ?? streamId).trim() || undefined,
        sessionActive: overrides?.sessionActive ?? sessionActive,
        maxEventsPerSecond: parsedMaxEvents,
        statsIntervalMs: parsedStatsInterval,
      });
      setActive(true);
      if (options?.auto) {
        const targetSessionId = (overrides?.sessionId ?? sessionId).trim();
        setSessionActive(true);
        setStatus(
          targetSessionId
            ? `Input iniciado automaticamente para sessao ${targetSessionId}.`
            : 'Input iniciado automaticamente para sessao ativa.',
        );
      } else {
        setStatus(`Servidor de input ativo em ${normalizedHost}:${parsedPort}.`);
      }
      return true;
    } catch (cause) {
      setError(
        `Falha ao iniciar servidor de input: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      );
      return false;
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

  const stopServer = useCallback(async (reason: 'manual' | 'automatic' = 'manual') => {
    setError('');
    try {
      await stopLanInputServer();
      setActive(false);
      setStats(null);
      setSessionActive(false);
      setStatus(
        reason === 'automatic'
          ? 'Sessao finalizada. Servidor de input parado automaticamente.'
          : 'Servidor de input parado.',
      );
    } catch (cause) {
      setError(
        `Falha ao parar servidor de input: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      );
    }
  }, []);

  const stopServerWithConfirm = useCallback(() => {
    if (!active) return;
    const confirmed = window.confirm('Parar o servidor de input agora?');
    if (!confirmed) return;
    void stopServer('manual');
  }, [active, stopServer]);

  const toggleSessionActive = useCallback(async () => {
    if (!active) return;
    const next = !sessionActive;
    if (!next) {
      const confirmed = window.confirm('Pausar input para a sessao atual?');
      if (!confirmed) return;
    }
    setError('');
    try {
      await setLanInputServerSessionActive(next);
      setSessionActive(next);
      setStatus(next ? 'Input habilitado para sessao ACTIVE.' : 'Input pausado para a sessao atual.');
    } catch (cause) {
      setError(
        `Falha ao alterar session ACTIVE: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      );
    }
  }, [active, sessionActive]);

  useEffect(() => {
    if (!isAvailable) return;

    let cancelled = false;
    const synchronizeAutoSession = async () => {
      if (!autoSessionActive || !defaultSessionId) {
        if (activeRef.current) {
          await stopServer('automatic');
        } else {
          setSessionActive(false);
        }
        setSessionId(defaultSessionId ?? '');
        setStreamId('');
        setTokenExpiresAt('');
        return;
      }

      const signal = await syncSessionCredentials(defaultSessionId);
      if (!signal || cancelled) return;

      const targetHost = bindHost.trim() || DEFAULT_BIND_HOST;
      const targetPort = signal.inputPort > 0 ? signal.inputPort : DEFAULT_BIND_PORT;
      const currentHost = bindHost.trim() || DEFAULT_BIND_HOST;
      const currentPort = parsePort(bindPort) ?? DEFAULT_BIND_PORT;
      const currentSessionId = sessionId.trim();
      const currentStreamId = streamId.trim();
      const currentToken = authToken.trim();

      const needsRestart =
        !activeRef.current
        || currentHost !== targetHost
        || currentPort !== targetPort
        || currentSessionId !== signal.sessionId
        || currentStreamId !== signal.streamId
        || currentToken !== signal.token;

      if (needsRestart) {
        await startServer(
          {
            bindHost: targetHost,
            bindPort: targetPort,
            authToken: signal.token,
            tokenExpiresAt: signal.tokenExpiresAt,
            sessionId: signal.sessionId,
            streamId: signal.streamId,
            sessionActive: true,
          },
          {
            auto: true,
            restartIfActive: activeRef.current,
          },
        );
        return;
      }

      try {
        await setLanInputServerSessionActive(true);
        setSessionActive(true);
        setStatus(`Input sincronizado automaticamente para sessao ${signal.sessionId}.`);
      } catch (cause) {
        setError(
          `Falha ao sincronizar session ACTIVE: ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
        );
      }
    };

    synchronizeAutoSession().catch((cause) => {
      if (cancelled) return;
      setError(
        `Falha ao sincronizar credenciais automaticamente: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      );
    });

    return () => {
      cancelled = true;
    };
  }, [
    authToken,
    autoSessionActive,
    bindHost,
    bindPort,
    defaultSessionId,
    isAvailable,
    parsePort,
    sessionId,
    startServer,
    stopServer,
    streamId,
    syncSessionCredentials,
  ]);

  if (!isAvailable) {
    return null;
  }

  const eventsDroppedTotal = (stats?.eventsDroppedInactive ?? 0) + (stats?.eventsDroppedRate ?? 0);
  const droppedPct = stats && stats.eventsReceived > 0 ? (eventsDroppedTotal / stats.eventsReceived) * 100 : 0;
  const tokenExpiresLabel = useMemo(() => {
    if (!tokenExpiresAt.trim()) return 'Nao definido';
    const parsed = Date.parse(tokenExpiresAt);
    if (!Number.isFinite(parsed)) return 'Formato invalido';
    return new Date(parsed).toLocaleString();
  }, [tokenExpiresAt]);
  const endpointHost = bindHost.trim() || DEFAULT_BIND_HOST;
  const endpointPort = parsePort(bindPort) ?? DEFAULT_BIND_PORT;
  const sessionScopeLabel = sessionId.trim() || 'Nenhuma sessao ativa';
  const transportHint = autoSessionActive ? 'Sessao ACTIVE detectada' : 'Sem sessao ACTIVE';

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <h3>Servidor de Input LAN (TCP)</h3>
        <span className={`${styles.badge} ${active ? styles.badgeOn : styles.badgeOff}`}>
          {active ? 'ATIVO' : 'PARADO'}
        </span>
      </div>
      <p className={styles.description}>
        Input iniciado automaticamente quando houver sessao ativa. Ajustes tecnicos ficam em
        Diagnostico (Avancado).
      </p>

      <div className={styles.summaryGrid}>
        <div className={styles.summaryCard}>
          <span className={styles.summaryLabel}>Endpoint</span>
          <strong className={styles.summaryValue}>{endpointHost}:{endpointPort}</strong>
          <span className={styles.summaryHint} title="Canal de input LAN dedicado">
            Transporte: LAN TCP
          </span>
        </div>
        <div className={styles.summaryCard}>
          <span className={styles.summaryLabel}>Sessao</span>
          <strong className={styles.summaryValue}>{sessionScopeLabel}</strong>
          <span className={styles.summaryHint} title={transportHint}>
            {transportHint}
          </span>
        </div>
        <div className={styles.summaryCard}>
          <span className={styles.summaryLabel}>Token</span>
          <strong className={styles.summaryValue}>{tokenExpiresLabel}</strong>
          <span className={styles.summaryHint}>Expiracao atual</span>
        </div>
      </div>

      <div className={styles.actions}>
        <button
          type="button"
          onClick={() => void syncSessionCredentials(defaultSessionId ?? undefined)}
          disabled={syncBusy}
          title="Atualiza token/sessionId/streamId da sessao atual"
        >
          {syncBusy ? 'Sincronizando...' : 'Sincronizar sessao'}
        </button>
        <button
          type="button"
          className={styles.ghost}
          onClick={toggleSessionActive}
          disabled={!active}
          title="Pausa/retoma apenas a injecao de input"
        >
          {sessionActive ? 'Pausar input' : 'Retomar input'}
        </button>
        <button
          type="button"
          className={styles.danger}
          onClick={stopServerWithConfirm}
          disabled={!active}
          title="Use apenas para diagnostico"
        >
          Parar input
        </button>
      </div>

      <p className={styles.status}>{status}</p>
      {error && <p className={styles.error}>{error}</p>}

      <details className={styles.diagnostics}>
        <summary title="Campos tecnicos para debug/dev">Diagnostico (Avancado)</summary>
        <p className={styles.diagnosticHint}>
          Use esta area apenas para testes. O fluxo normal e automatico.
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
              readOnly
              className={styles.readOnlyInput}
              placeholder="token da sessao"
            />
          </label>
          <label>
            Token expiresAt (ISO)
            <input
              value={tokenExpiresAt}
              readOnly
              className={styles.readOnlyInput}
              placeholder="2026-02-23T00:00:00.000Z"
            />
          </label>
          <label>
            Session ID
            <input
              value={sessionId}
              readOnly
              className={styles.readOnlyInput}
              placeholder="sessao ativa"
            />
          </label>
          <label>
            Stream ID
            <input
              value={streamId}
              readOnly
              className={styles.readOnlyInput}
              placeholder="stream filtrado"
            />
          </label>
        </div>

        <div className={styles.actions}>
          <button type="button" onClick={() => void startServer()} disabled={active || syncBusy}>
            Iniciar input (manual)
          </button>
          <button
            type="button"
            className={styles.ghost}
            onClick={() => setAuthToken(createInputToken())}
            disabled={active}
          >
            Gerar token local
          </button>
        </div>

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
      </details>
    </div>
  );
}
