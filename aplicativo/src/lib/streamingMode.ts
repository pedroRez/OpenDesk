export type StreamingMode = 'AUTO' | 'OPENDESK_ONLY' | 'MOONLIGHT_ONLY';
export type NativeTransportMode = 'relay' | 'lan';

type StreamTransportPayload = {
  recommended?: 'RELAY_WS' | 'UDP_LAN' | null;
  relay?: {
    url?: string | null;
  } | null;
  lan?: {
    host?: string | null;
    videoPort?: number | null;
    inputPort?: number | null;
  } | null;
};

type StreamSignalLike = {
  host?: string | null;
  videoPort?: number | null;
  inputPort?: number | null;
  transport?: StreamTransportPayload | null;
};

const DEFAULT_STREAMING_MODE: StreamingMode = 'AUTO';

function isValidStreamingMode(value: string): value is StreamingMode {
  return value === 'AUTO' || value === 'OPENDESK_ONLY' || value === 'MOONLIGHT_ONLY';
}

export function getStreamingMode(): StreamingMode {
  const raw = String(import.meta.env.VITE_STREAMING_MODE ?? '').trim().toUpperCase();
  if (isValidStreamingMode(raw)) return raw;
  return DEFAULT_STREAMING_MODE;
}

export function isMoonlightAllowed(mode: StreamingMode): boolean {
  return mode !== 'OPENDESK_ONLY';
}

function hasRelayTransport(signal: StreamSignalLike): boolean {
  return Boolean(signal.transport?.relay?.url?.trim());
}

function hasLanTransport(signal: StreamSignalLike): boolean {
  const lanHost = signal.transport?.lan?.host?.trim() ?? signal.host?.trim() ?? '';
  const lanVideoPort = signal.transport?.lan?.videoPort ?? signal.videoPort ?? 0;
  const lanInputPort = signal.transport?.lan?.inputPort ?? signal.inputPort ?? 0;
  return Boolean(
    lanHost
    && Number.isFinite(lanVideoPort)
    && lanVideoPort > 0
    && Number.isFinite(lanInputPort)
    && lanInputPort > 0,
  );
}

export function resolveNativeTransport(
  signal: StreamSignalLike,
  mode: StreamingMode,
): { transport: NativeTransportMode | null; reason: string } {
  if (mode === 'MOONLIGHT_ONLY') {
    return { transport: null, reason: 'mode_moonlight_only' };
  }

  const relayAvailable = hasRelayTransport(signal);
  const lanAvailable = hasLanTransport(signal);
  const recommended = signal.transport?.recommended ?? null;

  if (mode === 'OPENDESK_ONLY') {
    if (lanAvailable) return { transport: 'lan', reason: 'opendesk_only_lan' };
    if (relayAvailable) return { transport: 'relay', reason: 'opendesk_only_relay_fallback' };
    return { transport: null, reason: 'opendesk_only_no_transport' };
  }

  if (recommended === 'UDP_LAN' && lanAvailable) {
    return { transport: 'lan', reason: 'auto_recommended_lan' };
  }
  if (recommended === 'RELAY_WS' && relayAvailable) {
    return { transport: 'relay', reason: 'auto_recommended_relay' };
  }
  if (lanAvailable) return { transport: 'lan', reason: 'auto_fallback_lan' };
  if (relayAvailable) return { transport: 'relay', reason: 'auto_fallback_relay' };

  if (recommended === 'RELAY_WS') {
    return { transport: null, reason: 'auto_recommended_relay_missing' };
  }
  if (recommended === 'UDP_LAN') {
    return { transport: null, reason: 'auto_recommended_lan_missing' };
  }
  return { transport: null, reason: 'auto_no_transport' };
}

export function devStreamingLog(event: string, payload: Record<string, unknown>): void {
  if (!import.meta.env.DEV) return;
  console.log(`[STREAM][MODE] ${event}`, payload);
}
