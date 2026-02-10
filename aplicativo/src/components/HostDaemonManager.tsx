import { useEffect, useRef } from 'react';

import { apiBaseUrl, request } from '../lib/api';
import { useAuth } from '../lib/auth';
import { getLocalMachineId as getStoredMachineId, getLocalPcId, getPrimaryPcId } from '../lib/hostState';
import {
  isTauriRuntime,
  startHostDaemon,
  stopHostDaemon,
} from '../lib/hostDaemon';
import { closeStreamingGate, openStreamingGate } from '../lib/streamingGate';
import { unpairAllSunshineClients } from '../lib/sunshineApi';
import { useMode } from '../lib/mode';
import { useToast } from './Toast';

const APP_VERSION = '0.1.0';
const GATE_POLL_INTERVAL_MS = 2000;

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
  const gateStateRef = useRef<GateState>({
    pcId: null,
    open: false,
    extraPorts: [],
    extraPortsKey: '',
    clientAddress: null,
  });
  const gateSyncInFlight = useRef(false);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    const active = mode === 'HOST' && Boolean(user?.hostProfileId) && Boolean(user?.id);
    if (!active) {
      stopHostDaemon();
      return;
    }

    const pcId = getPrimaryPcId();
    startHostDaemon({
      apiUrl: apiBaseUrl,
      userId: user!.id,
      hostId: user!.hostProfileId!,
      pcId,
      version: APP_VERSION,
      intervalMs: 10000,
    }).catch((error) => {
      console.warn('host-daemon: falha ao iniciar', error);
    });

    return () => {
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
    const syncGate = async () => {
      if (!active || gateSyncInFlight.current || !hostId) return;
      gateSyncInFlight.current = true;
      try {
        const pcs = await request<GatePc[]>(`/hosts/${hostId}/pcs`);
        if (!active) return;

        const target = resolveGatePc(pcs);
        let state = gateStateRef.current;

        if (!target) {
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










