import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';

export type UdpLanReceiverOptions = {
  listenHost?: string;
  listenPort?: number;
  streamId?: string;
  maxFrameAgeMs?: number;
  maxPendingFrames?: number;
  statsIntervalMs?: number;
  probeHost?: string;
  probePort?: number;
};

export type UdpLanFrameEvent = {
  streamId: string;
  seq: number;
  timestampUs: number;
  flags: number;
  totalChunks: number;
  receivedChunks: number;
  payloadBytes: number;
  payloadBase64: string;
};

export type UdpLanStatsEvent = {
  streamId: string | null;
  listenHost: string;
  listenPort: number;
  packetsReceived: number;
  packetsAccepted: number;
  packetsInvalid: number;
  packetsDuplicate: number;
  packetsStreamMismatch: number;
  framesCompleted: number;
  framesDroppedTimeout: number;
  framesDroppedQueue: number;
  framesDroppedLate: number;
  framesDroppedGap: number;
  missingChunks: number;
  lossPct: number;
  jitterMs: number;
  fpsAssembled: number;
  bitrateKbps: number;
  pendingFrames: number;
  remoteAddress: string | null;
  remotePort: number | null;
};

export type UdpLanStoppedEvent = {
  reason: string;
};

export type UdpLanErrorEvent = {
  message: string;
};

export type UdpLanFeedbackMessage = {
  type: 'keyframe_request' | 'network_report' | 'reconnect';
  version?: number;
  token: string;
  sessionId?: string;
  streamId?: string;
  lossPct?: number;
  jitterMs?: number;
  freezeMs?: number;
  requestedBitrateKbps?: number;
  reason?: string;
};

export function decodeBase64ToBytes(base64: string): Uint8Array {
  if (!base64) return new Uint8Array();
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export async function startUdpLanReceiver(options: UdpLanReceiverOptions): Promise<void> {
  await invoke('start_udp_lan_receiver', { options });
}

export async function stopUdpLanReceiver(): Promise<void> {
  await invoke('stop_udp_lan_receiver');
}

export async function sendUdpLanFeedback(message: UdpLanFeedbackMessage): Promise<void> {
  await invoke('send_udp_lan_feedback', { message });
}

export async function onUdpLanFrame(handler: (event: UdpLanFrameEvent) => void): Promise<UnlistenFn> {
  return listen<UdpLanFrameEvent>('udp-lan-frame', (event) => handler(event.payload));
}

export async function onUdpLanStats(handler: (event: UdpLanStatsEvent) => void): Promise<UnlistenFn> {
  return listen<UdpLanStatsEvent>('udp-lan-stats', (event) => handler(event.payload));
}

export async function onUdpLanStopped(handler: (event: UdpLanStoppedEvent) => void): Promise<UnlistenFn> {
  return listen<UdpLanStoppedEvent>('udp-lan-stopped', (event) => handler(event.payload));
}

export async function onUdpLanError(handler: (event: UdpLanErrorEvent) => void): Promise<UnlistenFn> {
  return listen<UdpLanErrorEvent>('udp-lan-error', (event) => handler(event.payload));
}
