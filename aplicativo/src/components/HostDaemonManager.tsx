import { useEffect, useRef } from 'react';

import { apiBaseUrl, request, requestWithStatus } from '../lib/api';
import { useAuth } from '../lib/auth';
import { getLocalMachineId as getStoredMachineId, getLocalPcId, getPrimaryPcId } from '../lib/hostState';
import {
  getHostDaemonStatus,
  getHostRelayDaemonStatus,
  isTauriRuntime,
  startHostDaemon,
  startHostRelayDaemon,
  stopHostDaemon,
  stopHostRelayDaemon,
} from '../lib/hostDaemon';
import { closeStreamingGate, openStreamingGate } from '../lib/streamingGate';
import { unpairAllSunshineClients } from '../lib/sunshineApi';
import { useMode } from '../lib/mode';
import { useToast } from './Toast';

const APP_VERSION = '0.1.0';
const GATE_POLL_INTERVAL_MS = 2000;
const RELAY_SYNC_RETRY_MS = 2000;
const HEARTBEAT_SYNC_RETRY_MS = 5000;
const API_BASE_FALLBACK = 'http://localhost:3333';

type GatePc = {
  id: string;
  status: 'ONLINE' | 'OFFLINE' | 'BUSY';
  localPcId?: string | null;
  connectionPort?: number | null;
  activeSession?: { id: string; clientIp?: string | null } | null;
};

type GateState = {
  pcId: string | null;
  open: boolean;
  extraPorts: number[];
  extraPortsKey: string;
  clientAddress: string | null;
};

type StreamStartSignalResponse = {
  sessionId: string;
  streamId: string;
  token: string;
  tokenExpiresAt: string;
  transport?: {
    relay?: {
      url?: string | null;
      sessionId?: string | null;
      streamId?: string | null;
      token?: string | null;
      tokenExpiresAt?: string | null;
    } | null;
  } | null;
};

type RelayRuntimeState = {
  sessionId: string | null;
  streamId: string | null;
  token: string | null;
  relayUrl: string | null;
  tokenExpiresAtMs: number | null;
};

const normalizeExtraPorts = (port?: number | null): number[] => {
  if (!port) return [];
  const value = Math.trunc(port);
  if (value <= 0 || value > 65535) return [];
  return [value];
};

const buildExtraPortsKey = (ports: number[]) => ports.join(',');

const normalizeClientAddress = (value?: string | null): string | null => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
};

const resolveGatePc = (pcs: GatePc[]): GatePc | null => {
  const localPcId = getLocalPcId();
  if (localPcId) {
    const match = pcs.find((pc) => pc.id === localPcId);
    if (match) return match;
  }
  const machineId = getStoredMachineId();
  if (machineId) {
    const match = pcs.find((pc) => pc.localPcId === machineId);
    if (match) return match;
  }
  const primaryPcId = getPrimaryPcId();
  if (primaryPcId) {
    const match = pcs.find((pc) => pc.id === primaryPcId);
    if (match) return match;
  }
  if (pcs.length === 1) return pcs[0];
  return null;
};

export default function HostDaemonManager() {
  const { mode } = useMode();
  const { user } = useAuth();
  const toast = useToast();
  const apiResolutionLoggedRef = useRef(false);
  const runtimeWarningLoggedRef = useRef(false);
  const gateStateRef = useRef<GateState>({
    pcId: null,
    open: false,
    extraPorts: [],
    extraPortsKey: '',
    clientAddress: null,
  });
  const gateSyncInFlight = useRef(false);
  const relayStateRef = useRef<RelayRuntimeState>({
    sessionId: null,
    streamId: null,
    token: null,
    relayUrl: null,
    tokenExpiresAtMs: null,
  });
  const relaySyncInFlight = useRef(false);
  const relayLastAttemptAtRef = useRef(0);
  const heartbeatLastAttemptAtRef = useRef(0);

  const clearRelayRuntimeState = () => {
    relayStateRef.current = {
      sessionId: null,
      streamId: null,
      token: null,
      relayUrl: null,
      tokenExpiresAtMs: null,
    };
  };

  useEffect(() => {
    if (!isTauriRuntime()) {
      if (!runtimeWarningLoggedRef.current) {
        runtimeWarningLoggedRef.current = true;
        console.warn('[HOST_DAEMON] runtime nao-tauri detectado; heartbeat/relay-host automaticos desativados.');
      }
      return;
    }
    const active = mode === 'HOST' && Boolean(user?.hostProfileId) && Boolean(user?.id);
    if (!active) {
      stopHostRelayDaemon().catch((error) => {
        console.warn('[RELAY_HOST] falha ao parar ao sair do modo host', error);
      });
      clearRelayRuntimeState();
      stopHostDaemon();
      return;
    }

    if (!apiResolutionLoggedRef.current) {
      const envValue = String(import.meta.env.VITE_API_URL ?? '').trim();
      const fallbackUsed = !envValue;
      console.info('[HOST_DAEMON] apiBaseUrl resolved', {
        fromEnv: envValue || null,
        fallbackUsed,
        fallbackValue: fallbackUsed ? API_BASE_FALLBACK : null,
        value: apiBaseUrl,
      });
      apiResolutionLoggedRef.current = true;
    }

    const pcId = getPrimaryPcId();
    startHostDaemon({
      apiUrl: apiBaseUrl,
      userId: user!.id,
      hostId: user!.hostProfileId!,
      pcId,
      version: APP_VERSION,
      intervalMs: 20000,
    }).catch((error) => {
      console.warn('host-daemon: falha ao iniciar', error);
    });

    return () => {
      stopHostRelayDaemon().catch((error) => {
        console.warn('[RELAY_HOST] falha ao parar durante cleanup', error);
      });
      clearRelayRuntimeState();
      stopHostDaemon();
    };
  }, [mode, user?.hostProfileId, user?.id]);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let unlisten: (() => void) | null = null;

    import('@tauri-apps/api/window')
      .then(({ appWindow }) =>
        appWindow.onCloseRequested(async (event) => {
          const isHostMode = mode === 'HOST' && Boolean(user?.hostProfileId);
          if (isHostMode) {
            event.preventClose();
            await appWindow.hide();
            return;
          }
          await stopHostRelayDaemon().catch(() => undefined);
          clearRelayRuntimeState();
          await stopHostDaemon();
        }),
      )
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => undefined);

    return () => {
      if (unlisten) {
        unlisten();
      }
    };
  }, [mode, user?.hostProfileId]);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let unlisten: (() => void) | null = null;

    import('@tauri-apps/api/event')
      .then(({ listen }) =>
        listen<string>('tray-action', async (event) => {
          if (event.payload !== 'end_session') return;
          if (mode !== 'HOST' || !user?.hostProfileId) return;
          const pcId = getPrimaryPcId();
          if (!pcId) return;
          const confirmed = window.confirm('Encerrar a sessao ativa deste PC?');
          if (!confirmed) return;
          try {
            const response = await request<{ pc: unknown; sessionEnded: boolean }>(
              `/host/pcs/${pcId}/disconnect`,
              { method: 'POST' },
            );
            toast.show(
              response.sessionEnded ? 'Sessao encerrada via bandeja.' : 'PC liberado via bandeja.',
              'success',
            );
          } catch (error) {
            toast.show(error instanceof Error ? error.message : 'Falha ao encerrar sessao.', 'error');
          }
        }),
      )
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => undefined);

    return () => {
      if (unlisten) unlisten();
    };
  }, [mode, user?.hostProfileId, toast]);

  useEffect(() => {
    if (!isTauriRuntime()) return;

    const hostId = user?.hostProfileId ?? null;
    const userId = user?.id ?? null;
    const isHostMode = mode === 'HOST' && Boolean(hostId) && Boolean(userId);

    if (!isHostMode) {
      stopHostRelayDaemon().catch((error) => {
        console.warn('[RELAY_HOST] falha ao parar sem sessao ativa', error);
      });
      clearRelayRuntimeState();
      const prev = gateStateRef.current;
      if (prev.pcId) {
        closeStreamingGate(prev.pcId, { extraPorts: prev.extraPorts }).catch((error) => {
          console.warn('[STREAM_GATE] close on exit fail', error);
        });
        gateStateRef.current = { pcId: null, open: false, extraPorts: [], extraPortsKey: '', clientAddress: null };
      }
      return;
    }

    let active = true;

    const ensureHeartbeatDaemonRunning = async () => {
      if (!active || !hostId || !userId) return;
      if (getHostDaemonStatus() === 'RUNNING') return;

      const now = Date.now();
      if (now - heartbeatLastAttemptAtRef.current < HEARTBEAT_SYNC_RETRY_MS) {
        return;
      }
      heartbeatLastAttemptAtRef.current = now;
      console.warn('[HOST_DAEMON] heartbeat parado, tentando reiniciar', {
        hostId,
        userId,
      });
      try {
        await startHostDaemon({
          apiUrl: apiBaseUrl,
          userId,
          hostId,
          pcId: getPrimaryPcId(),
          version: APP_VERSION,
          intervalMs: 20000,
        });
      } catch (error) {
        console.warn('[HOST_DAEMON] falha ao reiniciar heartbeat', error);
      }
    };

    const stopRelayForReason = async (reason: string) => {
      const relayState = relayStateRef.current;
      const relayRunning = getHostRelayDaemonStatus() === 'RUNNING';
      if (!relayRunning && !relayState.sessionId) {
        return;
      }
      try {
        await stopHostRelayDaemon();
      } catch (error) {
        console.warn('[RELAY_HOST] falha ao parar relay-host', { reason, error });
      } finally {
        clearRelayRuntimeState();
      }
      console.info('[RELAY_HOST] relay-host parado', { reason });
    };

    const syncRelayHostForSession = async (activeSessionId: string) => {
      if (!active || !hostId || !userId) return;
      const sessionId = activeSessionId.trim();
      if (!sessionId) return;

      const relayRunning = getHostRelayDaemonStatus() === 'RUNNING';
      const relayState = relayStateRef.current;
      const sameSession = relayState.sessionId === sessionId;
      if (relayRunning && sameSession && relayState.streamId && relayState.token && relayState.relayUrl) {
        return;
      }

      const now = Date.now();
      if (relaySyncInFlight.current || now - relayLastAttemptAtRef.current < RELAY_SYNC_RETRY_MS) {
        return;
      }

      relaySyncInFlight.current = true;
      relayLastAttemptAtRef.current = now;

      try {
        const streamStartUrl = `${apiBaseUrl}/sessions/${sessionId}/stream/start`;
        console.info('[RELAY_HOST] relay-host start requested', {
          sessionId,
          streamStartUrl,
          apiBaseUrl,
        });
        const response = await requestWithStatus<StreamStartSignalResponse>(`/sessions/${sessionId}/stream/start`, {
          method: 'POST',
          body: JSON.stringify({}),
        });
        if (!active) return;

        if (!response.ok || !response.data) {
          console.warn('[RELAY_HOST] stream/start falhou para iniciar relay-host', {
            sessionId,
            status: response.status,
            error: response.errorMessage,
          });
          return;
        }

        const signal = response.data;
        const signalSessionId = (signal.transport?.relay?.sessionId ?? signal.sessionId ?? '').trim();
        const signalStreamId = (signal.transport?.relay?.streamId ?? signal.streamId ?? '').trim();
        const signalToken = (signal.transport?.relay?.token ?? signal.token ?? '').trim();
        const relayUrl = (signal.transport?.relay?.url ?? '').trim();
        const tokenExpiresAtRaw = signal.transport?.relay?.tokenExpiresAt ?? signal.tokenExpiresAt;
        const tokenExpiresAtMs = Date.parse(tokenExpiresAtRaw);
        const authExpiresAtMs =
          Number.isFinite(tokenExpiresAtMs) && tokenExpiresAtMs > 0 ? Math.trunc(tokenExpiresAtMs) : undefined;

        if (!signalSessionId || !signalStreamId || !signalToken || !relayUrl) {
          console.warn('[RELAY_HOST] sinalizacao relay incompleta', {
            sessionId,
            hasRelayUrl: Boolean(relayUrl),
            hasSignalSession: Boolean(signalSessionId),
            hasStreamId: Boolean(signalStreamId),
            hasToken: Boolean(signalToken),
          });
          return;
        }

        console.info('[RELAY_HOST] sinal de inicio recebido', {
          requestedSessionId: sessionId,
          sessionId: signalSessionId,
          streamId: signalStreamId,
          relayUrl,
          tokenExpiresAt: tokenExpiresAtRaw ?? null,
        });
        console.info('[RELAY_HOST] relay-host connecting', {
          sessionId: signalSessionId,
          streamId: signalStreamId,
          relayUrl,
        });

        const relayResult = await startHostRelayDaemon({
          relayUrl,
          sessionId: signalSessionId,
          streamId: signalStreamId,
          authToken: signalToken,
          userId,
          authExpiresAtMs,
        });

        relayStateRef.current = {
          sessionId: signalSessionId,
          streamId: signalStreamId,
          token: signalToken,
          relayUrl,
          tokenExpiresAtMs: authExpiresAtMs ?? null,
        };

        console.info('[RELAY_HOST] relay-host sincronizado', {
          result: relayResult,
          sessionId: signalSessionId,
          streamId: signalStreamId,
          relayUrl,
        });
      } catch (error) {
        console.warn('[RELAY_HOST] erro ao sincronizar relay-host', {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        relaySyncInFlight.current = false;
      }
    };
    const syncGate = async () => {
      if (!active || gateSyncInFlight.current || !hostId) return;
      gateSyncInFlight.current = true;
      try {
        await ensureHeartbeatDaemonRunning();
        const pcs = await request<GatePc[]>(`/hosts/${hostId}/pcs`);
        if (!active) return;

        const target = resolveGatePc(pcs);
        let state = gateStateRef.current;

        if (!target) {
          await stopRelayForReason('pc_not_found');
          if (state.pcId) {
            await closeStreamingGate(state.pcId, { extraPorts: state.extraPorts });
            if (state.open) {
              const unpair = await unpairAllSunshineClients();
              if (!unpair.ok && !unpair.skipped) {
                console.warn('[STREAM_GATE] unpair fail', unpair.error);
              }
            }
            gateStateRef.current = { pcId: null, open: false, extraPorts: [], extraPortsKey: '', clientAddress: null };
          }
          return;
        }

        const extraPorts = normalizeExtraPorts(target.connectionPort);
        const extraPortsKey = buildExtraPortsKey(extraPorts);
        const clientAddress = normalizeClientAddress(target.activeSession?.clientIp);
        const shouldOpen = target.status === 'BUSY' || Boolean(target.activeSession);
        const activeSessionId = target.activeSession?.id?.trim() ?? '';

        if (activeSessionId) {
          await syncRelayHostForSession(activeSessionId);
        } else {
          await stopRelayForReason('no_active_session');
        }

        if (state.pcId && state.pcId !== target.id) {
          await closeStreamingGate(state.pcId, { extraPorts: state.extraPorts });
          if (state.open) {
            const unpair = await unpairAllSunshineClients();
            if (!unpair.ok && !unpair.skipped) {
              console.warn('[STREAM_GATE] unpair fail', unpair.error);
            }
          }
          state = { pcId: null, open: false, extraPorts: [], extraPortsKey: '', clientAddress: null };
          gateStateRef.current = state;
        }

        const needsUpdate =
          state.pcId !== target.id ||
          state.open !== shouldOpen ||
          state.extraPortsKey !== extraPortsKey ||
          state.clientAddress !== clientAddress;

        if (!needsUpdate) {
          return;
        }

        if (shouldOpen) {
          if (clientAddress) {
            await openStreamingGate(target.id, { extraPorts, clientAddress });
          } else {
            console.warn('[STREAM_GATE] clientIp ausente, fallback any', { pcId: target.id });
            await openStreamingGate(target.id, { extraPorts });
          }
          gateStateRef.current = {
            pcId: target.id,
            open: true,
            extraPorts,
            extraPortsKey,
            clientAddress,
          };
          return;
        }

        await closeStreamingGate(target.id, { extraPorts });
        if (state.open) {
          const unpair = await unpairAllSunshineClients();
          if (!unpair.ok && !unpair.skipped) {
            console.warn('[STREAM_GATE] unpair fail', unpair.error);
          }
        }
        gateStateRef.current = {
          pcId: target.id,
          open: false,
          extraPorts,
          extraPortsKey,
          clientAddress: null,
        };
      } catch (error) {
        console.warn('[STREAM_GATE] sync fail', error);
      } finally {
        gateSyncInFlight.current = false;
      }
    };

    syncGate();
    const interval = setInterval(syncGate, GATE_POLL_INTERVAL_MS);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [mode, user?.hostProfileId, user?.id]);

  return null;
}










