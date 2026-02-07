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
import { useToast } from './Toast';

const APP_VERSION = '0.1.0';

export default function HostDaemonManager() {
  const { mode } = useMode();
  const { user } = useAuth();
  const toast = useToast();

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

  return null;
}
