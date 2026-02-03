import { useEffect } from 'react';

import { apiBaseUrl, request } from '../lib/api';
import { useAuth } from '../lib/auth';
import { getPrimaryPcId } from '../lib/hostState';
import {
  isTauriRuntime,
  startHostDaemon,
  stopHostDaemon,
} from '../lib/hostDaemon';
import { useMode } from '../lib/mode';

const APP_VERSION = '0.1.0';
const HEARTBEAT_INTERVAL_MS = 10000;

export default function HostDaemonManager() {
  const { mode } = useMode();
  const { user } = useAuth();

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
    const active = mode === 'HOST' && Boolean(user?.hostProfileId) && Boolean(user?.id);
    if (!active) return;

    const hostId = user!.hostProfileId!;
    console.log('[HEARTBEAT][DESKTOP] iniciado', {
      hostId,
      intervalMs: HEARTBEAT_INTERVAL_MS,
    });

    let interval: ReturnType<typeof setInterval> | null = null;

    const sendHeartbeat = async () => {
      const pcId = getPrimaryPcId();
      const timestamp = new Date().toISOString();
      console.log('[HEARTBEAT][DESKTOP] tick', timestamp);
      try {
        await request(`/hosts/${hostId}/heartbeat`, {
          method: 'POST',
          body: JSON.stringify({ pcId, timestamp }),
        });
        console.log('[HEARTBEAT][DESKTOP] sucesso', { hostId, pcId, timestamp });
      } catch (error) {
        console.error('[HEARTBEAT][DESKTOP] erro', {
          hostId,
          pcId,
          timestamp,
          error: error instanceof Error ? error.message : error,
        });
      }
    };

    sendHeartbeat();
    interval = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);

    return () => {
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
    };
  }, [mode, user?.hostProfileId, user?.id]);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let unlisten: (() => void) | null = null;

    import('@tauri-apps/api/window')
      .then(({ appWindow }) => appWindow.onCloseRequested(async () => {
        await stopHostDaemon();
      }))
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => undefined);

    return () => {
      if (unlisten) {
        unlisten();
      }
    };
  }, []);

  return null;
}
