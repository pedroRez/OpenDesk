import { useEffect } from 'react';

import { apiBaseUrl } from '../lib/api';
import { useAuth } from '../lib/auth';
import { getPrimaryPcId } from '../lib/hostState';
import {
  isTauriRuntime,
  startHostDaemon,
  stopHostDaemon,
} from '../lib/hostDaemon';
import { useMode } from '../lib/mode';

const APP_VERSION = '0.1.0';

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
