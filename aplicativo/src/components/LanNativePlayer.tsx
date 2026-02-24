import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { UnlistenFn } from '@tauri-apps/api/event';

import { isTauriRuntime } from '../lib/hostDaemon';
import {
  onLanInputClientStatus,
  onLanInputError,
  sendLanInputEvent,
  startLanInputClient,
  stopLanInputClient,
  type LanInputSendEvent,
} from '../lib/lanInput';
import {
  decodeBase64ToBytes,
  onUdpLanError,
  onUdpLanFrame,
  onUdpLanStats,
  onUdpLanStopped,
  sendUdpLanFeedback,
  startUdpLanReceiver,
  stopUdpLanReceiver,
  type UdpLanFeedbackMessage,
  type UdpLanFrameEvent,
  type UdpLanStatsEvent,
} from '../lib/udpLanReceiver';

import styles from './LanNativePlayer.module.css';

type NativeLanPlayerProps = {
  transportMode?: 'lan' | 'relay';
  defaultPort?: number | null;
  defaultInputHost?: string | null;
  defaultInputPort?: number | null;
  defaultStreamId?: string | null;
  defaultInputToken?: string | null;
  relayUrl?: string | null;
  relayUserId?: string | null;
  inputTokenExpiresAt?: string | null;
  sessionId?: string | null;
  sessionState?: 'STARTING' | 'ACTIVE' | 'INACTIVE';
  forceDisconnectKey?: number;
  autoConnectKey?: number;
  lockConnectionToSession?: boolean;
};

type DecoderSetup = {
  decoder: {
    decode: (chunk: unknown) => void;
    close: () => void;
    flush: () => Promise<void>;
    decodeQueueSize?: number;
  };
  encodedChunkCtor: new (options: {
    type: 'key' | 'delta';
    timestamp: number;
    data: Uint8Array;
  }) => unknown;
  description: string;
};

type RuntimeCounters = {
  renderedFrames: number;
  renderedWindowStartMs: number;
  assembledFrames: number;
  assembledWindowStartMs: number;
  receivedBytes: number;
  bitrateWindowStartMs: number;
  droppedBufferFrames: number;
  decodeErrors: number;
  inputEventsWindow: number;
  inputEventsWindowStartMs: number;
};

type InputEventBase =
  | { type: 'mouse_move'; dx: number; dy: number }
  | { type: 'mouse_button'; button: number; down: boolean }
  | { type: 'mouse_wheel'; deltaX: number; deltaY: number }
  | {
      type: 'key';
      code: string;
      down: boolean;
      ctrl?: boolean;
      alt?: boolean;
      shift?: boolean;
      meta?: boolean;
    }
  | { type: 'disconnect_hotkey' };

type RelayInputEventPayload =
  | { type: 'mouse_move'; seq: number; tsUs: number; dx: number; dy: number }
  | { type: 'mouse_button'; seq: number; tsUs: number; button: number; down: boolean }
  | { type: 'mouse_wheel'; seq: number; tsUs: number; deltaX: number; deltaY: number }
  | {
      type: 'key';
      seq: number;
      tsUs: number;
      scancode: string;
      down: boolean;
      ctrl?: boolean;
      alt?: boolean;
      shift?: boolean;
      meta?: boolean;
    }
  | { type: 'disconnect_hotkey'; seq: number; tsUs: number };

type RelayInputEnvelope = {
  type: 'input_event';
  version: 1;
  token: string;
  sessionId: string;
  streamId: string;
  event: RelayInputEventPayload;
};

type StreamHealthStatus = 'ok' | 'degraded' | 'reconnecting';

type StreamFeedbackMessage =
  | {
      type: 'request_keyframe' | 'reconnect';
      lossPct?: number;
      jitterMs?: number;
      freezeMs?: number;
      requestedBitrateKbps?: number;
      reason?: string;
      fpsDecode?: number;
      rttMs?: number;
      dropRatePct?: number;
      bufferLevel?: number;
      bitrateKbps?: number;
      status?: StreamHealthStatus;
    }
  | {
      type: 'report_stats';
      lossPct?: number;
      jitterMs?: number;
      freezeMs?: number;
      requestedBitrateKbps?: number;
      reason?: string;
      fpsDecode?: number;
      rttMs?: number;
      dropRatePct?: number;
      bufferLevel?: number;
      bitrateKbps?: number;
      status?: StreamHealthStatus;
    };

type RelayControlMessage =
  | {
      type: 'request_keyframe' | 'reconnect';
      token?: string;
      sessionId?: string;
      streamId?: string;
      lossPct?: number;
      jitterMs?: number;
      freezeMs?: number;
      requestedBitrateKbps?: number;
      reason?: string;
      sentAtUs?: number;
    }
  | {
      type: 'report_stats';
      token?: string;
      sessionId?: string;
      streamId?: string;
      lossPct?: number;
      jitterMs?: number;
      requestedBitrateKbps?: number;
      reason?: string;
      sentAtUs?: number;
      fpsDecode?: number;
      rttMs?: number;
      dropRatePct?: number;
      bufferLevel?: number;
      bitrateKbps?: number;
      status?: StreamHealthStatus;
    }
  | {
      type: 'stream_ping';
      token?: string;
      sessionId?: string;
      streamId?: string;
      pingId: number;
      sentAtUs: number;
    };

type RelayPongMessage = {
  type: 'stream_pong';
  pingId: number;
  sentAtUs?: number;
  receivedAtUs?: number;
  hostTsUs?: number;
  sessionId?: string;
  streamId?: string;
};

const STREAM_FLAG_KEYFRAME = 1;
const RELAY_FLAG_KEYFRAME = 1;
const RELAY_FRAME_HEADER_BYTES = 9;
const DEFAULT_LISTEN_PORT = 5004;
const DEFAULT_INPUT_PORT = 5505;
const RELAY_PING_INTERVAL_MS = 5000;
const RELAY_PONG_TIMEOUT_MS = 12_000;
const RELAY_DEGRADED_FREEZE_MS = 1800;
const RELAY_DEGRADED_FRAME_GAP_MS = 2500;
const RELAY_RECONNECT_FREEZE_MS = 4500;
const RELAY_RECONNECT_FRAME_GAP_MS = 3200;
const RELAY_REPORT_STATS_INTERVAL_MS = 2500;
const RELAY_KEYFRAME_REQUEST_COOLDOWN_MS = 900;
const RELAY_RECONNECT_BACKOFF_MS = [1000, 2000, 5000, 10000] as const;

function formatNumber(value: number, fractionDigits = 2): string {
  if (!Number.isFinite(value)) return '0';
  return value.toFixed(fractionDigits);
}

function nowUs(): number {
  return Math.trunc(Date.now() * 1000);
}

function isTokenExpired(expiresAtRaw?: string | null): boolean {
  if (!expiresAtRaw?.trim()) return false;
  const expiresAtMs = Date.parse(expiresAtRaw);
  return Number.isFinite(expiresAtMs) && expiresAtMs <= Date.now();
}

function toRelayInputEnvelope(
  token: string,
  sessionId: string,
  streamId: string,
  event: LanInputSendEvent,
): RelayInputEnvelope {
  const relayEvent: RelayInputEventPayload =
    event.type === 'mouse_move'
      ? { type: 'mouse_move', seq: event.seq, tsUs: event.tsUs, dx: event.dx, dy: event.dy }
      : event.type === 'mouse_button'
        ? {
            type: 'mouse_button',
            seq: event.seq,
            tsUs: event.tsUs,
            button: event.button,
            down: event.down,
          }
        : event.type === 'mouse_wheel'
          ? {
              type: 'mouse_wheel',
              seq: event.seq,
              tsUs: event.tsUs,
              deltaX: event.deltaX,
              deltaY: event.deltaY,
            }
          : event.type === 'key'
            ? {
                type: 'key',
                seq: event.seq,
                tsUs: event.tsUs,
                scancode: event.code,
                down: event.down,
                ctrl: event.ctrl,
                alt: event.alt,
                shift: event.shift,
                meta: event.meta,
              }
            : {
                type: 'disconnect_hotkey',
                seq: event.seq,
                tsUs: event.tsUs,
              };

  return {
    type: 'input_event',
    version: 1,
    token,
    sessionId,
    streamId,
    event: relayEvent,
  };
}

function parseRelayFramePayload(input: Blob | ArrayBuffer | Uint8Array): {
  flags: number;
  timestampUs: number;
  payload: Uint8Array;
} | null {
  let bytes: Uint8Array;
  if (input instanceof Uint8Array) {
    bytes = input;
  } else if (input instanceof ArrayBuffer) {
    bytes = new Uint8Array(input);
  } else {
    return null;
  }

  if (bytes.byteLength <= RELAY_FRAME_HEADER_BYTES) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const flags = view.getUint8(0);
  const timestampUsBigInt = view.getBigUint64(1, false);
  const timestampUsNumber = Number(timestampUsBigInt);
  const payload = bytes.subarray(RELAY_FRAME_HEADER_BYTES);
  return {
    flags,
    timestampUs: Number.isFinite(timestampUsNumber) ? timestampUsNumber : Date.now() * 1000,
    payload,
  };
}

export default function LanNativePlayer({
  transportMode = 'lan',
  defaultPort,
  defaultInputHost,
  defaultInputPort,
  defaultStreamId,
  defaultInputToken,
  relayUrl,
  relayUserId,
  inputTokenExpiresAt,
  sessionId,
  sessionState = 'INACTIVE',
  forceDisconnectKey = 0,
  autoConnectKey = 0,
  lockConnectionToSession = false,
}: NativeLanPlayerProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const decoderRef = useRef<DecoderSetup['decoder'] | null>(null);
  const encodedChunkCtorRef = useRef<DecoderSetup['encodedChunkCtor'] | null>(null);
  const relaySocketRef = useRef<WebSocket | null>(null);
  const unlistenersRef = useRef<UnlistenFn[]>([]);
  const activeTransportRef = useRef<'lan' | 'relay'>('lan');
  const connectedRef = useRef(false);
  const inputConnectedRef = useRef(false);
  const inputFocusedRef = useRef(false);
  const inputSeqRef = useRef(0);
  const inputPendingRef = useRef(0);
  const inputSendChainRef = useRef<Promise<void>>(Promise.resolve());
  const mouseDeltaRef = useRef({ dx: 0, dy: 0 });
  const mouseMoveTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastRenderAtRef = useRef(performance.now());
  const lastPayloadAtRef = useRef(performance.now());
  const lastKeyframeRequestAtRef = useRef(0);
  const lastNetworkReportAtRef = useRef(0);
  const lastPingSentAtRef = useRef(0);
  const lastPongAtRef = useRef(0);
  const lastPingIdRef = useRef(0);
  const relayRttMsRef = useRef(0);
  const relayConnectionIdRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptRef = useRef(0);
  const manualDisconnectRef = useRef(false);
  const connectFnRef = useRef<((options?: { isReconnect?: boolean }) => Promise<void>) | null>(null);
  const healthStatusRef = useRef<StreamHealthStatus>('ok');
  const packetsAcceptedRef = useRef(0);
  const droppedBufferFramesRef = useRef(0);
  const decodeErrorsRef = useRef(0);
  const renderedFramesTotalRef = useRef(0);
  const statsSampleRef = useRef({
    packetsAccepted: 0,
    droppedFrames: 0,
    decodeErrors: 0,
    renderedFrames: 0,
    sampledAtMs: performance.now(),
  });
  const reconnectInFlightRef = useRef(false);
  const requestKeyframeRef = useRef<(reason: string, freezeMs?: number) => void>(() => undefined);
  const latestNetworkRef = useRef({
    lossPct: 0,
    jitterMs: 0,
    bitrateKbps: 0,
    pendingFrames: 0,
  });
  const countersRef = useRef<RuntimeCounters>({
    renderedFrames: 0,
    renderedWindowStartMs: performance.now(),
    assembledFrames: 0,
    assembledWindowStartMs: performance.now(),
    receivedBytes: 0,
    bitrateWindowStartMs: performance.now(),
    droppedBufferFrames: 0,
    decodeErrors: 0,
    inputEventsWindow: 0,
    inputEventsWindowStartMs: performance.now(),
  });

  const [connected, setConnected] = useState(false);
  const [listenPort, setListenPort] = useState(() => String(defaultPort ?? DEFAULT_LISTEN_PORT));
  const [streamId, setStreamId] = useState(defaultStreamId ?? '');
  const [status, setStatus] = useState('Aguardando conexao.');
  const [decoderMode, setDecoderMode] = useState('n/a');
  const [fpsRender, setFpsRender] = useState(0);
  const [fpsAssembled, setFpsAssembled] = useState(0);
  const [bitrateKbps, setBitrateKbps] = useState(0);
  const [lossPct, setLossPct] = useState(0);
  const [jitterMs, setJitterMs] = useState(0);
  const [pendingFrames, setPendingFrames] = useState(0);
  const [droppedBufferFrames, setDroppedBufferFrames] = useState(0);
  const [decodeErrors, setDecodeErrors] = useState(0);
  const [packetsAccepted, setPacketsAccepted] = useState(0);
  const [inputHost, setInputHost] = useState(defaultInputHost ?? '');
  const [inputPort, setInputPort] = useState(() => String(defaultInputPort ?? DEFAULT_INPUT_PORT));
  const [inputToken, setInputToken] = useState(defaultInputToken ?? '');
  const [inputEventsSent, setInputEventsSent] = useState(0);
  const [inputEventsDropped, setInputEventsDropped] = useState(0);
  const [inputSendErrors, setInputSendErrors] = useState(0);
  const [inputEventsPerSec, setInputEventsPerSec] = useState(0);
  const [inputFocused, setInputFocused] = useState(false);
  const [inputStatus, setInputStatus] = useState('Input parado.');
  const [keyframeRequestsSent, setKeyframeRequestsSent] = useState(0);
  const [networkReportsSent, setNetworkReportsSent] = useState(0);
  const [reconnectAttempts, setReconnectAttempts] = useState(0);
  const [relayRttMs, setRelayRttMs] = useState(0);
  const [streamHealth, setStreamHealth] = useState<StreamHealthStatus>('ok');

  const isAvailable = useMemo(() => isTauriRuntime(), []);
  const effectiveTransportMode = transportMode === 'relay' ? 'relay' : 'lan';
  const isSessionConnectAllowed = sessionState === 'ACTIVE' || sessionState === 'STARTING';

  const applyStreamHealth = useCallback((next: StreamHealthStatus) => {
    if (healthStatusRef.current === next) return;
    healthStatusRef.current = next;
    setStreamHealth(next);
  }, []);

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    reconnectInFlightRef.current = false;
  }, []);

  useEffect(() => {
    if (connectedRef.current) return;
    if (!defaultInputHost) return;
    setInputHost(defaultInputHost);
  }, [defaultInputHost]);

  useEffect(() => {
    if (connectedRef.current) return;
    if (!defaultInputPort) return;
    setInputPort(String(defaultInputPort));
  }, [defaultInputPort]);

  useEffect(() => {
    if (connectedRef.current) return;
    if (!defaultPort) return;
    setListenPort(String(defaultPort));
  }, [defaultPort]);

  useEffect(() => {
    if (connectedRef.current) return;
    if (!defaultStreamId) return;
    setStreamId(defaultStreamId);
  }, [defaultStreamId]);

  useEffect(() => {
    if (connectedRef.current) return;
    if (!defaultInputToken) return;
    setInputToken(defaultInputToken);
  }, [defaultInputToken]);

  const closeDecoder = useCallback(async () => {
    const decoder = decoderRef.current;
    decoderRef.current = null;
    encodedChunkCtorRef.current = null;
    if (!decoder) return;
    try {
      await decoder.flush().catch(() => undefined);
      decoder.close();
    } catch {
      // ignore
    }
  }, []);

  const clearDecoderBufferShort = useCallback(async () => {
    const decoder = decoderRef.current;
    if (!decoder) return;
    await decoder.flush().catch(() => undefined);
  }, []);

  const clearListeners = useCallback(() => {
    const listeners = unlistenersRef.current.slice();
    unlistenersRef.current = [];
    for (const unlisten of listeners) {
      try {
        unlisten();
      } catch {
        // ignore
      }
    }
  }, []);

  const setupDecoder = useCallback(async (): Promise<DecoderSetup> => {
    const VideoDecoderCtor = (window as unknown as { VideoDecoder?: any }).VideoDecoder;
    const EncodedVideoChunkCtor = (window as unknown as { EncodedVideoChunk?: any }).EncodedVideoChunk;
    if (!VideoDecoderCtor || !EncodedVideoChunkCtor) {
      throw new Error('WebCodecs indisponivel no runtime atual.');
    }

    const codecCandidates = ['avc1.42E01E', 'avc1.4D401F', 'avc1.64001F'];
    const hardwareModes = ['prefer-hardware', 'no-preference', 'prefer-software'];

    for (const hardwareAcceleration of hardwareModes) {
      for (const codec of codecCandidates) {
        const config = {
          codec,
          optimizeForLatency: true,
          hardwareAcceleration,
        };

        let supported = true;
        if (typeof VideoDecoderCtor.isConfigSupported === 'function') {
          try {
            const result = await VideoDecoderCtor.isConfigSupported(config);
            supported = Boolean(result?.supported);
          } catch {
            supported = false;
          }
        }
        if (!supported) continue;

        try {
          const decoder = new VideoDecoderCtor({
            output: (videoFrame: any) => {
              const canvas = canvasRef.current;
              if (!canvas) {
                videoFrame.close();
                return;
              }
              const width = videoFrame.displayWidth || videoFrame.codedWidth;
              const height = videoFrame.displayHeight || videoFrame.codedHeight;
              if (width > 0 && height > 0 && (canvas.width !== width || canvas.height !== height)) {
                canvas.width = width;
                canvas.height = height;
              }

              const context = canvas.getContext('2d', {
                alpha: false,
                desynchronized: true,
              });
              if (context) {
                context.drawImage(videoFrame, 0, 0, canvas.width, canvas.height);
              }
              videoFrame.close();
              countersRef.current.renderedFrames += 1;
              renderedFramesTotalRef.current += 1;
              lastRenderAtRef.current = performance.now();
            },
            error: (error: unknown) => {
              countersRef.current.decodeErrors += 1;
              decodeErrorsRef.current += 1;
              setDecodeErrors(decodeErrorsRef.current);
              setStatus(`Erro de decode: ${error instanceof Error ? error.message : String(error)}`);
              requestKeyframeRef.current('decoder_error');
            },
          });
          decoder.configure(config);

          return {
            decoder,
            encodedChunkCtor: EncodedVideoChunkCtor,
            description: `${codec} / ${hardwareAcceleration}`,
          };
        } catch {
          // try next
        }
      }
    }

    throw new Error('Nao foi possivel configurar decoder H.264 (hardware ou software).');
  }, []);

  const stopInputChannel = useCallback(async () => {
    if (mouseMoveTimerRef.current) {
      clearInterval(mouseMoveTimerRef.current);
      mouseMoveTimerRef.current = null;
    }
    mouseDeltaRef.current = { dx: 0, dy: 0 };
    inputFocusedRef.current = false;
    setInputFocused(false);
    inputConnectedRef.current = false;
    await stopLanInputClient().catch(() => undefined);
    setInputStatus('Input parado.');
  }, []);

  const disconnect = useCallback(async (options: { silent?: boolean } = {}) => {
    clearReconnectTimer();
    relayConnectionIdRef.current += 1;
    connectedRef.current = false;
    setConnected(false);
    activeTransportRef.current = 'lan';
    applyStreamHealth('ok');
    relayRttMsRef.current = 0;
    setRelayRttMs(0);
    clearListeners();
    const relaySocket = relaySocketRef.current;
    relaySocketRef.current = null;
    if (relaySocket) {
      try {
        relaySocket.close(1000, 'client_disconnect');
      } catch {
        // ignore
      }
    }
    await stopInputChannel();
    await stopUdpLanReceiver().catch(() => undefined);
    await closeDecoder();
    if (!options.silent) {
      setStatus('Desconectado.');
    }
  }, [applyStreamHealth, clearListeners, clearReconnectTimer, closeDecoder, stopInputChannel]);

  useEffect(() => {
    if (!lockConnectionToSession) return;
    if (!connectedRef.current) return;
    if (isSessionConnectAllowed) return;
    manualDisconnectRef.current = true;
    disconnect().catch(() => undefined);
    setStatus('Conexao encerrada: sessao nao esta ACTIVE/STARTING.');
  }, [disconnect, isSessionConnectAllowed, lockConnectionToSession, sessionState]);

  useEffect(() => {
    if (!connectedRef.current) return;
    manualDisconnectRef.current = true;
    disconnect().catch(() => undefined);
    setStatus('Conexao encerrada pelo ciclo da sessao.');
  }, [disconnect, forceDisconnectKey]);

  const sendInput = useCallback(
    (event: InputEventBase, options: { dropIfBusy?: boolean } = {}) => {
      if (!inputConnectedRef.current) return;
      if (activeTransportRef.current === 'relay') {
        if (sessionState !== 'ACTIVE') {
          setInputEventsDropped((prev) => prev + 1);
          return;
        }
        if (isTokenExpired(inputTokenExpiresAt)) {
          inputConnectedRef.current = false;
          setInputStatus('Input bloqueado: token expirado.');
          setInputEventsDropped((prev) => prev + 1);
          manualDisconnectRef.current = true;
          disconnect().catch(() => undefined);
          return;
        }
      }
      if (options.dropIfBusy && inputPendingRef.current > 6) {
        setInputEventsDropped((prev) => prev + 1);
        return;
      }

      const seq = ++inputSeqRef.current;
      const tsUs = nowUs();
      const payload: LanInputSendEvent =
        event.type === 'mouse_move'
          ? { type: 'mouse_move', seq, tsUs, dx: event.dx, dy: event.dy }
          : event.type === 'mouse_button'
            ? { type: 'mouse_button', seq, tsUs, button: event.button, down: event.down }
            : event.type === 'mouse_wheel'
              ? { type: 'mouse_wheel', seq, tsUs, deltaX: event.deltaX, deltaY: event.deltaY }
              : event.type === 'key'
                ? {
                    type: 'key',
                    seq,
                    tsUs,
                    code: event.code,
                    down: event.down,
                    ctrl: event.ctrl,
                    alt: event.alt,
                    shift: event.shift,
                    meta: event.meta,
                  }
                : { type: 'disconnect_hotkey', seq, tsUs };

      inputPendingRef.current += 1;
      inputSendChainRef.current = inputSendChainRef.current
        .then(() => {
          if (activeTransportRef.current !== 'relay') {
            return sendLanInputEvent(payload);
          }
          const socket = relaySocketRef.current;
          if (!socket || socket.readyState !== WebSocket.OPEN) {
            throw new Error('relay websocket nao conectado.');
          }
          const tokenScope = inputToken.trim();
          const sessionScope = sessionId?.trim() ?? '';
          const streamScope = streamId.trim();
          if (!tokenScope || !sessionScope || !streamScope) {
            throw new Error('escopo input relay invalido.');
          }
          const envelope = toRelayInputEnvelope(tokenScope, sessionScope, streamScope, payload);
          socket.send(JSON.stringify(envelope));
          return undefined;
        })
        .then(() => {
          setInputEventsSent((prev) => prev + 1);
          countersRef.current.inputEventsWindow += 1;
        })
        .catch((error) => {
          setInputSendErrors((prev) => prev + 1);
          setInputStatus(`Erro envio input: ${error instanceof Error ? error.message : String(error)}`);
        })
        .finally(() => {
          inputPendingRef.current = Math.max(0, inputPendingRef.current - 1);
        });
    },
    [disconnect, inputToken, inputTokenExpiresAt, sessionId, sessionState, streamId],
  );

  const startMouseMovePump = useCallback(() => {
    if (mouseMoveTimerRef.current) {
      clearInterval(mouseMoveTimerRef.current);
    }
    mouseMoveTimerRef.current = setInterval(() => {
      if (!inputConnectedRef.current || !inputFocusedRef.current) return;
      const delta = mouseDeltaRef.current;
      if (delta.dx === 0 && delta.dy === 0) return;
      const dx = delta.dx;
      const dy = delta.dy;
      mouseDeltaRef.current = { dx: 0, dy: 0 };
      sendInput({ type: 'mouse_move', dx, dy }, { dropIfBusy: true });
    }, 8);
  }, [sendInput]);

  const sendFeedback = useCallback(
    async (message: StreamFeedbackMessage): Promise<void> => {
      const token = inputToken.trim();
      if (!token) return;
      const sessionScope = sessionId?.trim() ?? '';
      const streamScope = streamId.trim();

      if (activeTransportRef.current === 'relay') {
        const socket = relaySocketRef.current;
        if (!socket || socket.readyState !== WebSocket.OPEN || !sessionScope || !streamScope) {
          return;
        }
        const payload = {
          ...message,
          token,
          sessionId: sessionScope,
          streamId: streamScope,
          sentAtUs: nowUs(),
        };
        socket.send(JSON.stringify(payload));
        return;
      }

      const lanType: UdpLanFeedbackMessage['type'] =
        message.type === 'request_keyframe'
          ? 'keyframe_request'
          : message.type === 'report_stats'
            ? 'network_report'
            : 'reconnect';
      await sendUdpLanFeedback({
        type: lanType,
        token,
        sessionId: sessionScope || undefined,
        streamId: streamScope || undefined,
        lossPct: message.lossPct,
        jitterMs: message.jitterMs,
        freezeMs: message.freezeMs,
        requestedBitrateKbps: message.requestedBitrateKbps,
        reason: message.reason,
      });
    },
    [inputToken, sessionId, streamId],
  );

  const sendStreamPing = useCallback(() => {
    if (activeTransportRef.current !== 'relay') return;
    const socket = relaySocketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    const token = inputToken.trim();
    const sessionScope = sessionId?.trim() ?? '';
    const streamScope = streamId.trim();
    if (!token || !sessionScope || !streamScope) return;

    const pingId = ++lastPingIdRef.current;
    const sentAtUs = nowUs();
    lastPingSentAtRef.current = performance.now();
    socket.send(
      JSON.stringify({
        type: 'stream_ping',
        token,
        sessionId: sessionScope,
        streamId: streamScope,
        pingId,
        sentAtUs,
      } satisfies RelayControlMessage),
    );
  }, [inputToken, sessionId, streamId]);

  const requestKeyframe = useCallback(
    (reason: string, freezeMs = 0) => {
      const now = performance.now();
      if (now - lastKeyframeRequestAtRef.current < RELAY_KEYFRAME_REQUEST_COOLDOWN_MS) {
        return;
      }
      lastKeyframeRequestAtRef.current = now;
      const network = latestNetworkRef.current;
      sendFeedback({
        type: 'request_keyframe',
        freezeMs: Math.max(0, Math.trunc(freezeMs)),
        lossPct: network.lossPct,
        jitterMs: network.jitterMs,
        reason,
      })
        .then(() => {
          setKeyframeRequestsSent((prev) => prev + 1);
        })
        .catch((error) => {
          setStatus(
            `Falha ao solicitar keyframe: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        });
    },
    [sendFeedback],
  );

  useEffect(() => {
    requestKeyframeRef.current = requestKeyframe;
  }, [requestKeyframe]);

  const scheduleReconnect = useCallback(
    (reason: string) => {
      if (effectiveTransportMode !== 'relay') return;
      if (manualDisconnectRef.current) return;
      if (lockConnectionToSession && !isSessionConnectAllowed) return;
      if (isTokenExpired(inputTokenExpiresAt)) {
        setStatus('Reconexao automatica bloqueada: token expirado.');
        return;
      }
      if (reconnectTimerRef.current) return;

      const index = Math.min(reconnectAttemptRef.current, RELAY_RECONNECT_BACKOFF_MS.length - 1);
      const delayMs = RELAY_RECONNECT_BACKOFF_MS[index];
      reconnectAttemptRef.current += 1;
      reconnectInFlightRef.current = true;
      setReconnectAttempts((prev) => prev + 1);
      applyStreamHealth('reconnecting');
      setStatus(`Relay instavel (${reason}). Reconectando em ${delayMs}ms...`);

      reconnectTimerRef.current = setTimeout(() => {
        reconnectTimerRef.current = null;
        const runner = connectFnRef.current;
        if (!runner) {
          reconnectInFlightRef.current = false;
          return;
        }
        runner({ isReconnect: true })
          .catch((error) => {
            setStatus(
              `Falha na reconexao automatica: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
            scheduleReconnect('retry_failed');
          })
          .finally(() => {
            reconnectInFlightRef.current = false;
          });
      }, delayMs);
    },
    [
      applyStreamHealth,
      effectiveTransportMode,
      inputTokenExpiresAt,
      isSessionConnectAllowed,
      lockConnectionToSession,
    ],
  );

  const markPacketAccepted = useCallback(() => {
    packetsAcceptedRef.current += 1;
    setPacketsAccepted(packetsAcceptedRef.current);
  }, []);

  const decodeEncodedChunk = useCallback((chunk: { flags: number; timestampUs: number; payload: Uint8Array }) => {
    if (!connectedRef.current) return;
    const decoder = decoderRef.current;
    const EncodedVideoChunkCtor = encodedChunkCtorRef.current;
    if (!decoder || !EncodedVideoChunkCtor) return;

    lastPayloadAtRef.current = performance.now();
    countersRef.current.receivedBytes += chunk.payload.byteLength;
    countersRef.current.assembledFrames += 1;
    const keyframe = (chunk.flags & STREAM_FLAG_KEYFRAME) !== 0;
    const queueSize = Number(decoder.decodeQueueSize ?? 0);

    if (!keyframe && queueSize > 2) {
      countersRef.current.droppedBufferFrames += 1;
      droppedBufferFramesRef.current += 1;
      setDroppedBufferFrames(droppedBufferFramesRef.current);
      return;
    }

    try {
      const encoded = new EncodedVideoChunkCtor({
        type: keyframe ? 'key' : 'delta',
        timestamp: chunk.timestampUs,
        data: chunk.payload,
      });
      decoder.decode(encoded);
    } catch (error) {
      countersRef.current.decodeErrors += 1;
      decodeErrorsRef.current += 1;
      setDecodeErrors(decodeErrorsRef.current);
      setStatus(`Falha ao decodificar chunk: ${error instanceof Error ? error.message : String(error)}`);
      void clearDecoderBufferShort();
      requestKeyframeRef.current('decode_exception');
    }
  }, [clearDecoderBufferShort]);

  const handleStats = useCallback((payload: UdpLanStatsEvent) => {
    if (activeTransportRef.current !== 'lan') return;
    setFpsAssembled(payload.fpsAssembled);
    setBitrateKbps(payload.bitrateKbps);
    setLossPct(payload.lossPct);
    setJitterMs(payload.jitterMs);
    setPendingFrames(payload.pendingFrames);
    setPacketsAccepted(payload.packetsAccepted);
    packetsAcceptedRef.current = payload.packetsAccepted;
    latestNetworkRef.current = {
      lossPct: payload.lossPct,
      jitterMs: payload.jitterMs,
      bitrateKbps: payload.bitrateKbps,
      pendingFrames: payload.pendingFrames,
    };

    if (!connectedRef.current) return;
    const now = performance.now();
    const degraded = payload.lossPct >= 4 || payload.jitterMs >= 25;
    if (!degraded || now - lastNetworkReportAtRef.current < 1000) {
      return;
    }
    lastNetworkReportAtRef.current = now;
    sendFeedback({
      type: 'report_stats',
      lossPct: payload.lossPct,
      jitterMs: payload.jitterMs,
      requestedBitrateKbps: Math.max(600, Math.trunc(payload.bitrateKbps * 0.9)),
      reason: 'network_degraded',
      fpsDecode: fpsRender,
      dropRatePct: 0,
      rttMs: relayRttMsRef.current,
      bufferLevel: payload.pendingFrames,
      bitrateKbps: payload.bitrateKbps,
      status: healthStatusRef.current,
    })
      .then(() => {
        setNetworkReportsSent((prev) => prev + 1);
      })
      .catch((error) => {
        setStatus(
          `Falha ao enviar feedback de rede: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
  }, [fpsRender, sendFeedback]);

  const handleFrame = useCallback((payload: UdpLanFrameEvent) => {
    if (activeTransportRef.current !== 'lan') return;
    markPacketAccepted();
    const bytes = decodeBase64ToBytes(payload.payloadBase64);
    decodeEncodedChunk({
      flags: payload.flags,
      timestampUs: payload.timestampUs,
      payload: bytes,
    });
  }, [decodeEncodedChunk, markPacketAccepted]);

  const connect = useCallback(async (options: { isReconnect?: boolean } = {}) => {
    const isReconnectAttempt = options.isReconnect === true;

    if (!isAvailable) {
      setStatus('Player nativo disponivel apenas no runtime Tauri.');
      return;
    }
    if (lockConnectionToSession && !isSessionConnectAllowed) {
      setStatus('Conexao bloqueada: sessao precisa estar ACTIVE ou STARTING.');
      return;
    }
    if (isTokenExpired(inputTokenExpiresAt)) {
      setStatus('Token de stream expirado. Atualize a sinalizacao da sessao.');
      return;
    }

    const token = inputToken.trim();
    if (!token) {
      setStatus('Token de stream obrigatorio.');
      return;
    }

    const udpPort = Number.parseInt(listenPort, 10);
    const inputPortParsed = Number.parseInt(inputPort, 10);
    const needsLanValidation = effectiveTransportMode === 'lan';
    if (needsLanValidation && (!Number.isFinite(udpPort) || udpPort <= 0 || udpPort > 65535)) {
      setStatus('Porta UDP invalida.');
      return;
    }
    if (
      needsLanValidation
      && (!Number.isFinite(inputPortParsed) || inputPortParsed <= 0 || inputPortParsed > 65535)
    ) {
      setStatus('Porta de input invalida.');
      return;
    }
    if (needsLanValidation && !inputHost.trim()) {
      setStatus('Host de input obrigatorio.');
      return;
    }
    if (effectiveTransportMode === 'relay' && !relayUrl?.trim()) {
      setStatus('Relay URL ausente. Sincronize o signaling da sessao.');
      return;
    }
    if (effectiveTransportMode === 'relay' && !relayUserId?.trim()) {
      setStatus('Relay userId ausente. Faca login novamente e tente conectar.');
      return;
    }
    if (effectiveTransportMode === 'relay' && !sessionId?.trim()) {
      setStatus('Session ID obrigatorio para relay.');
      return;
    }
    if (effectiveTransportMode === 'relay' && !streamId.trim()) {
      setStatus('Stream ID obrigatorio para relay.');
      return;
    }

    if (!isReconnectAttempt) {
      manualDisconnectRef.current = false;
      reconnectAttemptRef.current = 0;
      setReconnectAttempts(0);
    }
    clearReconnectTimer();

    try {
      await disconnect({ silent: true });

      countersRef.current = {
        renderedFrames: 0,
        renderedWindowStartMs: performance.now(),
        assembledFrames: 0,
        assembledWindowStartMs: performance.now(),
        receivedBytes: 0,
        bitrateWindowStartMs: performance.now(),
        droppedBufferFrames: 0,
        decodeErrors: 0,
        inputEventsWindow: 0,
        inputEventsWindowStartMs: performance.now(),
      };
      packetsAcceptedRef.current = 0;
      droppedBufferFramesRef.current = 0;
      decodeErrorsRef.current = 0;
      renderedFramesTotalRef.current = 0;
      statsSampleRef.current = {
        packetsAccepted: 0,
        droppedFrames: 0,
        decodeErrors: 0,
        renderedFrames: 0,
        sampledAtMs: performance.now(),
      };
      relayRttMsRef.current = 0;
      setRelayRttMs(0);
      setDroppedBufferFrames(0);
      setDecodeErrors(0);
      setFpsRender(0);
      setFpsAssembled(0);
      setBitrateKbps(0);
      setLossPct(0);
      setJitterMs(0);
      setPendingFrames(0);
      setPacketsAccepted(0);
      setInputEventsSent(0);
      setInputEventsDropped(0);
      setInputSendErrors(0);
      setInputEventsPerSec(0);
      setKeyframeRequestsSent(0);
      setNetworkReportsSent(0);
      inputSeqRef.current = 0;
      inputPendingRef.current = 0;
      inputSendChainRef.current = Promise.resolve();
      reconnectInFlightRef.current = false;
      lastRenderAtRef.current = performance.now();
      lastPayloadAtRef.current = performance.now();
      lastKeyframeRequestAtRef.current = 0;
      lastNetworkReportAtRef.current = 0;
      lastPingSentAtRef.current = 0;
      lastPongAtRef.current = 0;
      lastPingIdRef.current = 0;
      applyStreamHealth('ok');

      const decoderSetup = await setupDecoder();
      decoderRef.current = decoderSetup.decoder;
      encodedChunkCtorRef.current = decoderSetup.encodedChunkCtor;
      setDecoderMode(decoderSetup.description);

      activeTransportRef.current = effectiveTransportMode;

      if (effectiveTransportMode === 'lan') {
        const frameUnlisten = await onUdpLanFrame(handleFrame);
        const statsUnlisten = await onUdpLanStats(handleStats);
        const stoppedUnlisten = await onUdpLanStopped(() => {
          connectedRef.current = false;
          setConnected(false);
          setStatus('Receiver UDP finalizado.');
        });
        const udpErrorUnlisten = await onUdpLanError((event) => {
          setStatus(`Erro receiver: ${event.message}`);
        });
        const inputClientStatusUnlisten = await onLanInputClientStatus((event) => {
          setInputStatus(event.message);
          inputConnectedRef.current = event.connected;
        });
        const inputErrorUnlisten = await onLanInputError((event) => {
          setInputStatus(`Erro input: ${event.message}`);
        });
        unlistenersRef.current = [
          frameUnlisten,
          statsUnlisten,
          stoppedUnlisten,
          udpErrorUnlisten,
          inputClientStatusUnlisten,
          inputErrorUnlisten,
        ];

        await startUdpLanReceiver({
          listenHost: '0.0.0.0',
          listenPort: udpPort,
          streamId: streamId.trim() || undefined,
          maxFrameAgeMs: 40,
          maxPendingFrames: 96,
          statsIntervalMs: 1000,
        });

        await startLanInputClient({
          host: inputHost.trim(),
          port: inputPortParsed,
          authToken: token,
          sessionId: sessionId ?? undefined,
          streamId: streamId.trim() || undefined,
          connectTimeoutMs: 3000,
        });
        inputConnectedRef.current = true;
        setInputStatus('Input conectado.');

        startMouseMovePump();

        connectedRef.current = true;
        setConnected(true);
        setStatus('Conectado via LAN UDP. Aguardando frames...');
        return;
      }

      inputConnectedRef.current = false;
      setInputStatus('Conectando input via relay...');
      const relayEndpoint = new URL(relayUrl!.trim());
      relayEndpoint.searchParams.set('role', 'client');
      relayEndpoint.searchParams.set('sessionId', sessionId!.trim());
      relayEndpoint.searchParams.set('streamId', streamId.trim());
      relayEndpoint.searchParams.set('token', token);
      relayEndpoint.searchParams.set('userId', relayUserId!.trim());
      const relaySocket = new WebSocket(relayEndpoint.toString());
      relaySocket.binaryType = 'arraybuffer';
      relaySocketRef.current = relaySocket;
      const connectionId = ++relayConnectionIdRef.current;

      relaySocket.onopen = () => {
        if (connectionId !== relayConnectionIdRef.current) return;
        connectedRef.current = true;
        setConnected(true);
        reconnectAttemptRef.current = 0;
        reconnectInFlightRef.current = false;
        const now = performance.now();
        lastPongAtRef.current = now;
        lastPingSentAtRef.current = 0;
        lastNetworkReportAtRef.current = 0;
        const relayInputAllowed = sessionState === 'ACTIVE' && !isTokenExpired(inputTokenExpiresAt);
        inputConnectedRef.current = relayInputAllowed;
        setInputStatus(
          relayInputAllowed
            ? 'Input conectado via relay WS.'
            : sessionState !== 'ACTIVE'
              ? 'Input relay bloqueado: sessao nao esta ACTIVE.'
              : 'Input relay bloqueado: token expirado.',
        );
        startMouseMovePump();
        applyStreamHealth('ok');
        setStatus(
          isReconnectAttempt
            ? 'Relay reconectado. Sincronizando keyframe...'
            : 'Conectado via relay websocket. Aguardando frames...',
        );
        if (isReconnectAttempt) {
          requestKeyframe('post_reconnect');
        }
      };
      relaySocket.onclose = (event) => {
        if (connectionId !== relayConnectionIdRef.current) return;
        relaySocketRef.current = null;
        inputConnectedRef.current = false;
        setInputStatus('Input parado.');
        const wasConnected = connectedRef.current;
        connectedRef.current = false;
        setConnected(false);
        if (manualDisconnectRef.current) {
          setStatus(`Relay encerrado (code=${event.code}).`);
          return;
        }
        if (!wasConnected && event.code === 1000) {
          return;
        }
        setStatus(`Relay desconectado (code=${event.code}).`);
        scheduleReconnect(`ws_close_${event.code}`);
      };
      relaySocket.onerror = () => {
        if (connectionId !== relayConnectionIdRef.current) return;
        setStatus('Erro no websocket relay.');
      };
      relaySocket.onmessage = (event) => {
        if (connectionId !== relayConnectionIdRef.current) return;
        if (typeof event.data === 'string') {
          try {
            const parsed = JSON.parse(event.data) as { type?: string; [key: string]: unknown };
            if (parsed.type === 'relay.welcome') {
              return;
            }
            if (parsed.type === 'stream_pong') {
              const pong = parsed as RelayPongMessage;
              if (typeof pong.pingId !== 'number') return;
              if (pong.sessionId && sessionId?.trim() && pong.sessionId !== sessionId.trim()) return;
              if (
                pong.streamId
                && streamId.trim()
                && pong.streamId.trim().toLowerCase() !== streamId.trim().toLowerCase()
              ) {
                return;
              }
              lastPongAtRef.current = performance.now();
              const receivedNowUs = nowUs();
              const rttMs = typeof pong.sentAtUs === 'number'
                ? Math.max(0, (receivedNowUs - pong.sentAtUs) / 1000)
                : Math.max(0, performance.now() - lastPingSentAtRef.current);
              relayRttMsRef.current = rttMs;
              setRelayRttMs(rttMs);
              if (!reconnectInFlightRef.current) {
                applyStreamHealth('ok');
              }
              return;
            }
          } catch {
            // ignore text frames malformed from relay
          }
          return;
        }

        if (event.data instanceof Blob) {
          event.data
            .arrayBuffer()
            .then((arrayBuffer) => {
              if (connectionId !== relayConnectionIdRef.current) return;
              const parsed = parseRelayFramePayload(arrayBuffer);
              if (!parsed) return;
              markPacketAccepted();
              decodeEncodedChunk({
                flags: parsed.flags & RELAY_FLAG_KEYFRAME ? STREAM_FLAG_KEYFRAME : 0,
                timestampUs: parsed.timestampUs,
                payload: parsed.payload,
              });
            })
            .catch(() => undefined);
          return;
        }

        if (event.data instanceof ArrayBuffer) {
          const parsed = parseRelayFramePayload(event.data);
          if (!parsed) return;
          markPacketAccepted();
          decodeEncodedChunk({
            flags: parsed.flags & RELAY_FLAG_KEYFRAME ? STREAM_FLAG_KEYFRAME : 0,
            timestampUs: parsed.timestampUs,
            payload: parsed.payload,
          });
        }
      };

      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error('timeout ao conectar relay websocket.'));
        }, 8000);

        relaySocket.addEventListener(
          'open',
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
        relaySocket.addEventListener(
          'error',
          () => {
            clearTimeout(timer);
            reject(new Error('falha ao abrir relay websocket.'));
          },
          { once: true },
        );
      });
    } catch (error) {
      setStatus(`Falha ao conectar player nativo: ${error instanceof Error ? error.message : String(error)}`);
      await disconnect({ silent: true });
      if (isReconnectAttempt) {
        scheduleReconnect('connect_failed');
      }
    }
  }, [
    applyStreamHealth,
    clearReconnectTimer,
    decodeEncodedChunk,
    disconnect,
    effectiveTransportMode,
    handleFrame,
    handleStats,
    inputHost,
    inputPort,
    inputToken,
    isAvailable,
    listenPort,
    lockConnectionToSession,
    markPacketAccepted,
    requestKeyframe,
    scheduleReconnect,
    sessionId,
    sessionState,
    setupDecoder,
    startMouseMovePump,
    streamId,
    relayUrl,
    relayUserId,
    inputTokenExpiresAt,
    isSessionConnectAllowed,
  ]);

  useEffect(() => {
    if (!autoConnectKey) return;
    connect().catch(() => undefined);
  }, [autoConnectKey, connect]);

  useEffect(() => {
    connectFnRef.current = connect;
    return () => {
      if (connectFnRef.current === connect) {
        connectFnRef.current = null;
      }
    };
  }, [connect]);

  const handleManualDisconnect = useCallback(() => {
    manualDisconnectRef.current = true;
    disconnect().catch(() => undefined);
  }, [disconnect]);

  useEffect(() => {
    if (!connectedRef.current) return;
    if (activeTransportRef.current !== 'relay') return;
    if (sessionState !== 'ACTIVE') {
      inputConnectedRef.current = false;
      setInputStatus('Input relay bloqueado: sessao nao esta ACTIVE.');
      return;
    }
    if (isTokenExpired(inputTokenExpiresAt)) {
      inputConnectedRef.current = false;
      setInputStatus('Input bloqueado: token expirado.');
      manualDisconnectRef.current = true;
      disconnect().catch(() => undefined);
      return;
    }
    inputConnectedRef.current = true;
    setInputStatus('Input conectado via relay WS.');
  }, [disconnect, inputTokenExpiresAt, sessionState]);

  useEffect(() => {
    if (!connected) return;
    if (!inputTokenExpiresAt?.trim()) return;
    const expiresAtMs = Date.parse(inputTokenExpiresAt);
    if (!Number.isFinite(expiresAtMs)) return;
    if (expiresAtMs <= Date.now()) {
      inputConnectedRef.current = false;
      setInputStatus('Input bloqueado: token expirado.');
      manualDisconnectRef.current = true;
      disconnect().catch(() => undefined);
      return;
    }
    const timeoutMs = Math.max(0, expiresAtMs - Date.now());
    const timer = setTimeout(() => {
      if (!connectedRef.current) return;
      inputConnectedRef.current = false;
      setInputStatus('Input bloqueado: token expirado.');
      manualDisconnectRef.current = true;
      disconnect().catch(() => undefined);
    }, timeoutMs + 10);
    return () => clearTimeout(timer);
  }, [connected, disconnect, inputTokenExpiresAt]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!connectedRef.current || !inputConnectedRef.current || !inputFocusedRef.current) return;
      const target = event.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA'].includes(target.tagName)) return;

      if (event.ctrlKey && event.shiftKey && event.code === 'KeyQ') {
        event.preventDefault();
        sendInput({ type: 'disconnect_hotkey' });
        manualDisconnectRef.current = true;
        disconnect().catch(() => undefined);
        return;
      }

      event.preventDefault();
      sendInput({
        type: 'key',
        code: event.code,
        down: true,
        ctrl: event.ctrlKey,
        alt: event.altKey,
        shift: event.shiftKey,
        meta: event.metaKey,
      });
    };

    const onKeyUp = (event: KeyboardEvent) => {
      if (!connectedRef.current || !inputConnectedRef.current || !inputFocusedRef.current) return;
      const target = event.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA'].includes(target.tagName)) return;
      event.preventDefault();
      sendInput({
        type: 'key',
        code: event.code,
        down: false,
        ctrl: event.ctrlKey,
        alt: event.altKey,
        shift: event.shiftKey,
        meta: event.metaKey,
      });
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [disconnect, sendInput]);

  useEffect(() => {
    const timer = setInterval(() => {
      if (!connectedRef.current) return;
      if (lockConnectionToSession && !isSessionConnectAllowed) return;

      const now = performance.now();
      const freezeMs = now - lastRenderAtRef.current;
      const payloadGapMs = now - lastPayloadAtRef.current;
      const network = latestNetworkRef.current;

      if (activeTransportRef.current === 'relay') {
        const socket = relaySocketRef.current;
        if (!socket || socket.readyState !== WebSocket.OPEN) {
          scheduleReconnect('socket_not_open');
          return;
        }

        if (now - lastPingSentAtRef.current >= RELAY_PING_INTERVAL_MS) {
          sendStreamPing();
        }

        const pongTimedOut =
          lastPongAtRef.current > 0 && now - lastPongAtRef.current >= RELAY_PONG_TIMEOUT_MS;
        const degraded =
          freezeMs >= RELAY_DEGRADED_FREEZE_MS
          || payloadGapMs >= RELAY_DEGRADED_FRAME_GAP_MS
          || pongTimedOut;
        const shouldReconnect =
          freezeMs >= RELAY_RECONNECT_FREEZE_MS
          || payloadGapMs >= RELAY_RECONNECT_FRAME_GAP_MS
          || (lastPongAtRef.current > 0 && now - lastPongAtRef.current >= RELAY_PONG_TIMEOUT_MS + 3500);

        if (degraded) {
          applyStreamHealth(shouldReconnect ? 'reconnecting' : 'degraded');
          if (now - lastKeyframeRequestAtRef.current >= RELAY_KEYFRAME_REQUEST_COOLDOWN_MS) {
            void clearDecoderBufferShort();
            requestKeyframe(
              pongTimedOut ? 'heartbeat_timeout' : 'decoder_freeze',
              Math.max(freezeMs, payloadGapMs),
            );
          }
        } else if (!reconnectInFlightRef.current) {
          applyStreamHealth('ok');
        }

        if (now - lastNetworkReportAtRef.current >= RELAY_REPORT_STATS_INTERVAL_MS) {
          lastNetworkReportAtRef.current = now;
          const sample = statsSampleRef.current;
          const elapsedMs = Math.max(1, now - sample.sampledAtMs);
          const deltaPackets = Math.max(0, packetsAcceptedRef.current - sample.packetsAccepted);
          const deltaDropped = Math.max(0, droppedBufferFramesRef.current - sample.droppedFrames);
          const deltaErrors = Math.max(0, decodeErrorsRef.current - sample.decodeErrors);
          const deltaRendered = Math.max(0, renderedFramesTotalRef.current - sample.renderedFrames);
          const totalObserved = Math.max(1, deltaPackets + deltaDropped + deltaErrors);
          const dropRatePct = ((deltaDropped + deltaErrors) * 100) / totalObserved;
          const fpsDecode = (deltaRendered * 1000) / elapsedMs;
          sample.packetsAccepted = packetsAcceptedRef.current;
          sample.droppedFrames = droppedBufferFramesRef.current;
          sample.decodeErrors = decodeErrorsRef.current;
          sample.renderedFrames = renderedFramesTotalRef.current;
          sample.sampledAtMs = now;

          sendFeedback({
            type: 'report_stats',
            reason: 'periodic',
            lossPct: network.lossPct,
            jitterMs: network.jitterMs,
            fpsDecode,
            rttMs: relayRttMsRef.current,
            dropRatePct,
            bufferLevel: network.pendingFrames,
            bitrateKbps: network.bitrateKbps,
            status: shouldReconnect ? 'reconnecting' : degraded ? 'degraded' : 'ok',
          })
            .then(() => {
              setNetworkReportsSent((prev) => prev + 1);
            })
            .catch(() => undefined);
        }

        if (shouldReconnect) {
          sendFeedback({
            type: 'reconnect',
            freezeMs: Math.max(0, Math.trunc(Math.max(freezeMs, payloadGapMs))),
            lossPct: network.lossPct,
            jitterMs: network.jitterMs,
            reason: 'auto_reconnect',
          }).catch(() => undefined);
          scheduleReconnect('degraded_stream');
        }
        return;
      }

      if (freezeMs >= 1200 && payloadGapMs <= 2500) {
        requestKeyframe('decoder_freeze', freezeMs);
      }
    }, 350);

    return () => clearInterval(timer);
  }, [
    applyStreamHealth,
    clearDecoderBufferShort,
    isSessionConnectAllowed,
    lockConnectionToSession,
    requestKeyframe,
    scheduleReconnect,
    sendStreamPing,
    sendFeedback,
  ]);

  useEffect(() => {
    const timer = setInterval(() => {
      const counters = countersRef.current;
      const now = performance.now();

      const elapsedRenderSec = Math.max(0.001, (now - counters.renderedWindowStartMs) / 1000);
      setFpsRender(counters.renderedFrames / elapsedRenderSec);
      if (elapsedRenderSec >= 1) {
        counters.renderedFrames = 0;
        counters.renderedWindowStartMs = now;
      }

      const elapsedAssembledSec = Math.max(0.001, (now - counters.assembledWindowStartMs) / 1000);
      if (elapsedAssembledSec >= 1) {
        setFpsAssembled(counters.assembledFrames / elapsedAssembledSec);
        counters.assembledFrames = 0;
        counters.assembledWindowStartMs = now;
      }

      const elapsedBitrateSec = Math.max(0.001, (now - counters.bitrateWindowStartMs) / 1000);
      if (elapsedBitrateSec >= 1) {
        const kbps = ((counters.receivedBytes * 8) / 1000) / elapsedBitrateSec;
        setBitrateKbps(kbps > 0 ? kbps : 0);
        counters.receivedBytes = 0;
        counters.bitrateWindowStartMs = now;
      }

      const elapsedInputSec = Math.max(0.001, (now - counters.inputEventsWindowStartMs) / 1000);
      if (elapsedInputSec >= 1) {
        setInputEventsPerSec(counters.inputEventsWindow / elapsedInputSec);
        counters.inputEventsWindow = 0;
        counters.inputEventsWindowStartMs = now;
      }
    }, 300);

    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    return () => {
      manualDisconnectRef.current = true;
      disconnect().catch(() => undefined);
    };
  }, [disconnect]);

  return (
    <div className={styles.container}>
      <div className={styles.row}>
        <div className={styles.field}>
          <label htmlFor="udp-port">
            {effectiveTransportMode === 'lan' ? 'Porta UDP (video)' : 'Relay URL'}
          </label>
          <input
            id="udp-port"
            value={effectiveTransportMode === 'lan' ? listenPort : relayUrl ?? ''}
            onChange={(event) => setListenPort(event.target.value)}
            disabled={connected || lockConnectionToSession || effectiveTransportMode !== 'lan'}
            placeholder={effectiveTransportMode === 'lan' ? '5004' : 'wss://api/stream/relay'}
          />
        </div>
        <div className={styles.field}>
          <label htmlFor="udp-stream-id">
            {effectiveTransportMode === 'lan' ? 'Stream ID (opcional)' : 'Stream ID (obrigatorio)'}
          </label>
          <input
            id="udp-stream-id"
            value={streamId}
            onChange={(event) => setStreamId(event.target.value)}
            disabled={connected || lockConnectionToSession}
            placeholder="UUID do stream"
          />
        </div>
      </div>

      <div className={styles.row}>
        {effectiveTransportMode === 'lan' && (
          <div className={styles.field}>
            <label htmlFor="input-host">Host input</label>
            <input
              id="input-host"
              value={inputHost}
              onChange={(event) => setInputHost(event.target.value)}
              disabled={connected || lockConnectionToSession}
              placeholder="IP do host"
            />
          </div>
        )}
        {effectiveTransportMode === 'lan' && (
          <div className={styles.field}>
            <label htmlFor="input-port">Porta input</label>
            <input
              id="input-port"
              value={inputPort}
              onChange={(event) => setInputPort(event.target.value)}
              disabled={connected || lockConnectionToSession}
              placeholder="5505"
            />
          </div>
        )}
        <div className={styles.field}>
          <label htmlFor="input-token">Token stream</label>
          <input
            id="input-token"
            value={inputToken}
            onChange={(event) => setInputToken(event.target.value)}
            disabled={connected || lockConnectionToSession}
            placeholder="token da sessao ativa"
          />
        </div>
      </div>

      <div className={styles.actions}>
        <button
          type="button"
          onClick={() => connect().catch(() => undefined)}
          disabled={connected || !isAvailable || (lockConnectionToSession && !isSessionConnectAllowed)}
        >
          {effectiveTransportMode === 'lan' ? 'Conectar player nativo (LAN)' : 'Conectar player nativo (Relay)'}
        </button>
        <button type="button" className={styles.ghost} onClick={handleManualDisconnect} disabled={!connected}>
          Desconectar
        </button>
      </div>

      <p
        className={`${styles.status} ${
          status.toLowerCase().includes('erro') || status.toLowerCase().includes('falha') ? styles.error : ''
        }`}
      >
        {status}
      </p>
      <p className={styles.status}>Transporte ativo: {effectiveTransportMode === 'lan' ? 'LAN UDP' : 'Relay WS'}</p>
      {effectiveTransportMode === 'relay' && relayUserId && (
        <p className={styles.status}>Relay userId: {relayUserId}</p>
      )}
      <p className={styles.status}>{inputStatus}</p>
      {lockConnectionToSession && (
        <p className={styles.status}>Estado da sessao para streaming: {sessionState}</p>
      )}
      {inputTokenExpiresAt && (
        <p className={styles.status}>Token expira em: {new Date(inputTokenExpiresAt).toLocaleString()}</p>
      )}
      <p className={styles.status}>
        Hotkey de desconectar: Ctrl + Shift + Q (com foco no player).
      </p>

      <div className={styles.canvasWrap}>
        <canvas
          ref={canvasRef}
          className={styles.canvas}
          tabIndex={0}
          onFocus={() => {
            inputFocusedRef.current = true;
            setInputFocused(true);
          }}
          onBlur={() => {
            inputFocusedRef.current = false;
            setInputFocused(false);
          }}
          onContextMenu={(event) => event.preventDefault()}
          onPointerDown={(event) => {
            const canvas = canvasRef.current;
            canvas?.focus();
            inputFocusedRef.current = true;
            setInputFocused(true);
            sendInput({ type: 'mouse_button', button: event.button, down: true });
          }}
          onPointerUp={(event) => {
            sendInput({ type: 'mouse_button', button: event.button, down: false });
          }}
          onPointerMove={(event) => {
            if (!inputConnectedRef.current || !inputFocusedRef.current) return;
            mouseDeltaRef.current.dx += Math.trunc(event.movementX);
            mouseDeltaRef.current.dy += Math.trunc(event.movementY);
          }}
          onWheel={(event) => {
            if (!inputConnectedRef.current || !inputFocusedRef.current) return;
            event.preventDefault();
            sendInput(
              {
                type: 'mouse_wheel',
                deltaX: Math.trunc(event.deltaX),
                deltaY: Math.trunc(event.deltaY),
              },
              { dropIfBusy: true },
            );
          }}
        />
        {effectiveTransportMode === 'relay' && (
          <div
            className={`${styles.overlay} ${
              streamHealth === 'ok'
                ? styles.overlayOk
                : streamHealth === 'degraded'
                  ? styles.overlayDegraded
                  : styles.overlayReconnecting
            }`}
          >
            <span>status {streamHealth}</span>
            <span>fps {formatNumber(fpsRender, 1)}</span>
            <span>bitrate {formatNumber(bitrateKbps, 0)} kbps</span>
            <span>rtt {formatNumber(relayRttMs, 1)} ms</span>
          </div>
        )}
      </div>

      <div className={styles.metrics}>
        <div className={styles.metric}>
          <span className={styles.metricLabel}>Decoder</span>
          <span className={styles.metricValue}>{decoderMode}</span>
        </div>
        <div className={styles.metric}>
          <span className={styles.metricLabel}>FPS render</span>
          <span className={styles.metricValue}>{formatNumber(fpsRender)}</span>
        </div>
        <div className={styles.metric}>
          <span className={styles.metricLabel}>FPS assembled</span>
          <span className={styles.metricValue}>{formatNumber(fpsAssembled)}</span>
        </div>
        <div className={styles.metric}>
          <span className={styles.metricLabel}>Bitrate (kbps)</span>
          <span className={styles.metricValue}>{formatNumber(bitrateKbps)}</span>
        </div>
        <div className={styles.metric}>
          <span className={styles.metricLabel}>Stream status</span>
          <span className={styles.metricValue}>{streamHealth}</span>
        </div>
        <div className={styles.metric}>
          <span className={styles.metricLabel}>RTT (ms)</span>
          <span className={styles.metricValue}>{formatNumber(relayRttMs, 1)}</span>
        </div>
        <div className={styles.metric}>
          <span className={styles.metricLabel}>Loss (%)</span>
          <span className={styles.metricValue}>{formatNumber(lossPct)}</span>
        </div>
        <div className={styles.metric}>
          <span className={styles.metricLabel}>Jitter (ms)</span>
          <span className={styles.metricValue}>{formatNumber(jitterMs, 3)}</span>
        </div>
        <div className={styles.metric}>
          <span className={styles.metricLabel}>Pending frames</span>
          <span className={styles.metricValue}>{pendingFrames}</span>
        </div>
        <div className={styles.metric}>
          <span className={styles.metricLabel}>Dropped buffer</span>
          <span className={styles.metricValue}>{droppedBufferFrames}</span>
        </div>
        <div className={styles.metric}>
          <span className={styles.metricLabel}>Decode errors</span>
          <span className={styles.metricValue}>{decodeErrors}</span>
        </div>
        <div className={styles.metric}>
          <span className={styles.metricLabel}>Packets accepted</span>
          <span className={styles.metricValue}>{packetsAccepted}</span>
        </div>
        <div className={styles.metric}>
          <span className={styles.metricLabel}>Input focus</span>
          <span className={styles.metricValue}>{inputFocused ? 'Ativo' : 'Inativo'}</span>
        </div>
        <div className={styles.metric}>
          <span className={styles.metricLabel}>Input events/s</span>
          <span className={styles.metricValue}>{formatNumber(inputEventsPerSec)}</span>
        </div>
        <div className={styles.metric}>
          <span className={styles.metricLabel}>Input sent</span>
          <span className={styles.metricValue}>{inputEventsSent}</span>
        </div>
        <div className={styles.metric}>
          <span className={styles.metricLabel}>Input dropped</span>
          <span className={styles.metricValue}>{inputEventsDropped}</span>
        </div>
        <div className={styles.metric}>
          <span className={styles.metricLabel}>Input send errors</span>
          <span className={styles.metricValue}>{inputSendErrors}</span>
        </div>
        <div className={styles.metric}>
          <span className={styles.metricLabel}>Keyframe req</span>
          <span className={styles.metricValue}>{keyframeRequestsSent}</span>
        </div>
        <div className={styles.metric}>
          <span className={styles.metricLabel}>Network reports</span>
          <span className={styles.metricValue}>{networkReportsSent}</span>
        </div>
        <div className={styles.metric}>
          <span className={styles.metricLabel}>Reconnect attempts</span>
          <span className={styles.metricValue}>{reconnectAttempts}</span>
        </div>
      </div>
    </div>
  );
}
