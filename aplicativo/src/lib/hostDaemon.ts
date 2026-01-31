import { Command, type Child } from '@tauri-apps/api/shell';
import { resolveResource } from '@tauri-apps/api/path';

const DAEMON_RESOURCE = 'host-daemon/dist/index.js';

let daemonProcess: Child | null = null;

export type HostDaemonConfig = {
  apiUrl: string;
  userId: string;
  hostId: string;
  pcId?: string | null;
  version: string;
  intervalMs?: number;
};

export function isTauriRuntime(): boolean {
  if (typeof window === 'undefined') return false;
  return Boolean((window as unknown as { __TAURI__?: unknown }).__TAURI__);
}

async function resolveEntryPath(): Promise<string> {
  const override = import.meta.env.VITE_HOST_DAEMON_ENTRY;
  if (override) return override;
  try {
    return await resolveResource(DAEMON_RESOURCE);
  } catch {
    return DAEMON_RESOURCE;
  }
}

export async function startHostDaemon(config: HostDaemonConfig): Promise<void> {
  if (!isTauriRuntime()) return;
  if (daemonProcess) return;

  const entry = await resolveEntryPath();
  const args = [
    entry,
    '--api-url',
    config.apiUrl,
    '--user-id',
    config.userId,
    '--host-id',
    config.hostId,
    '--version',
    config.version,
  ];

  if (config.pcId) {
    args.push('--pc-id', config.pcId);
  }
  if (config.intervalMs) {
    args.push('--interval-ms', String(config.intervalMs));
  }

  const command = new Command('node', args);
  daemonProcess = await command.spawn();
}

export async function stopHostDaemon(): Promise<void> {
  if (!daemonProcess) return;
  try {
    await daemonProcess.kill();
  } finally {
    daemonProcess = null;
  }
}

export function getHostDaemonStatus(): 'RUNNING' | 'STOPPED' {
  return daemonProcess ? 'RUNNING' : 'STOPPED';
}
