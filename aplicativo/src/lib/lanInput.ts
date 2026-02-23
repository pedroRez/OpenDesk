import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

export type StartLanInputServerOptions = {
  bindHost?: string;
  bindPort?: number;
  authToken: string;
  authExpiresAtMs?: number;
  sessionId?: string;
  streamId?: string;
  sessionActive?: boolean;
  maxEventsPerSecond?: number;
  statsIntervalMs?: number;
};

export type StartLanInputClientOptions = {
  host: string;
  port: number;
  authToken: string;
  sessionId?: string;
  streamId?: string;
  connectTimeoutMs?: number;
};

export type LanInputSendEvent =
  | { type: 'mouse_move'; seq: number; tsUs: number; dx: number; dy: number }
  | { type: 'mouse_button'; seq: number; tsUs: number; button: number; down: boolean }
  | { type: 'mouse_wheel'; seq: number; tsUs: number; deltaX: number; deltaY: number }
  | {
      type: 'key';
      seq: number;
      tsUs: number;
      code: string;
      down: boolean;
      ctrl?: boolean;
      alt?: boolean;
      shift?: boolean;
      meta?: boolean;
    }
  | { type: 'disconnect_hotkey'; seq: number; tsUs: number };

export type LanInputServerStatsEvent = {
  active: boolean;
  bindHost: string;
  bindPort: number;
  authenticatedClients: number;
  authFailures: number;
  eventsReceived: number;
  eventsInjected: number;
  eventsDroppedRate: number;
  eventsDroppedInactive: number;
  injectErrors: number;
  mouseMoves: number;
  mouseButtons: number;
  mouseWheels: number;
  keyEvents: number;
  disconnectHotkeys: number;
  eventsPerSecLimit: number;
};

export type LanInputServerStatusEvent = {
  active: boolean;
  message: string;
};

export type LanInputClientStatusEvent = {
  connected: boolean;
  host: string;
  port: number;
  message: string;
};

export type LanInputErrorEvent = {
  message: string;
};

export async function startLanInputServer(options: StartLanInputServerOptions): Promise<void> {
  await invoke('start_lan_input_server', { options });
}

export async function stopLanInputServer(): Promise<void> {
  await invoke('stop_lan_input_server');
}

export async function setLanInputServerSessionActive(active: boolean): Promise<void> {
  await invoke('set_lan_input_server_session_active', { active });
}

export async function startLanInputClient(options: StartLanInputClientOptions): Promise<void> {
  await invoke('start_lan_input_client', { options });
}

export async function stopLanInputClient(): Promise<void> {
  await invoke('stop_lan_input_client');
}

export async function sendLanInputEvent(event: LanInputSendEvent): Promise<void> {
  await invoke('send_lan_input_event', { event });
}

export async function onLanInputServerStats(
  handler: (event: LanInputServerStatsEvent) => void,
): Promise<UnlistenFn> {
  return listen<LanInputServerStatsEvent>('lan-input-server-stats', (event) => handler(event.payload));
}

export async function onLanInputServerStatus(
  handler: (event: LanInputServerStatusEvent) => void,
): Promise<UnlistenFn> {
  return listen<LanInputServerStatusEvent>('lan-input-server-status', (event) => handler(event.payload));
}

export async function onLanInputClientStatus(
  handler: (event: LanInputClientStatusEvent) => void,
): Promise<UnlistenFn> {
  return listen<LanInputClientStatusEvent>('lan-input-client-status', (event) => handler(event.payload));
}

export async function onLanInputError(handler: (event: LanInputErrorEvent) => void): Promise<UnlistenFn> {
  return listen<LanInputErrorEvent>('lan-input-error', (event) => handler(event.payload));
}
