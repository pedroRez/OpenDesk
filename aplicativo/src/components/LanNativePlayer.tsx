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

const STREAM_FLAG_KEYFRAME = 1;
const RELAY_FLAG_KEYFRAME = 1;
const RELAY_FRAME_HEADER_BYTES = 9;
const DEFAULT_LISTEN_PORT = 5004;
const DEFAULT_INPUT_PORT = 5505;

function formatNumber(value: number, fractionDigits = 2): string {
  if (!Number.isFinite(value)) return '0';
  return value.toFixed(fractionDigits);
}

function nowUs(): number {
  return Math.trunc(Date.now() * 1000);
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
  const lastReconnectAtRef = useRef(0);
  const reconnectInFlightRef = useRef(false);
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

  const isAvailable = useMemo(() => isTauriRuntime(), []);
  const effectiveTransportMode = transportMode === 'relay' ? 'relay' : 'lan';
  const isSessionConnectAllowed = sessionState === 'ACTIVE' || sessionState === 'STARTING';

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
              lastRenderAtRef.current = performance.now();
            },
            error: (error: unknown) => {
              countersRef.current.decodeErrors += 1;
              setDecodeErrors(countersRef.current.decodeErrors);
              setStatus(`Erro de decode: ${error instanceof Error ? error.message : String(error)}`);
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

  const disconnect = useCallback(async () => {
    reconnectInFlightRef.current = false;
    connectedRef.current = false;
    setConnected(false);
    activeTransportRef.current = 'lan';
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
    setStatus('Desconectado.');
  }, [clearListeners, closeDecoder, stopInputChannel]);

  useEffect(() => {
    if (!lockConnectionToSession) return;
    if (!connectedRef.current) return;
    if (isSessionConnectAllowed) return;
    disconnect().catch(() => undefined);
    setStatus('Conexao encerrada: sessao nao esta ACTIVE/STARTING.');
  }, [disconnect, isSessionConnectAllowed, lockConnectionToSession, sessionState]);

  useEffect(() => {
    if (!connectedRef.current) return;
    disconnect().catch(() => undefined);
    setStatus('Conexao encerrada pelo ciclo da sessao.');
  }, [disconnect, forceDisconnectKey]);

  const sendInput = useCallback(
    (event: InputEventBase, options: { dropIfBusy?: boolean } = {}) => {
      if (!inputConnectedRef.current) return;
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
        .then(() => sendLanInputEvent(payload))
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
    [],
  );

  const sendFeedback = useCallback(
    async (
      message: Omit<UdpLanFeedbackMessage, 'token' | 'sessionId' | 'streamId'>,
    ): Promise<void> => {
      const token = inputToken.trim();
      if (!token) return;
      const payload: UdpLanFeedbackMessage = {
        ...message,
        token,
        sessionId: sessionId ?? undefined,
        streamId: streamId.trim() || undefined,
      };
      if (activeTransportRef.current === 'relay') {
        const socket = relaySocketRef.current;
        if (!socket || socket.readyState !== WebSocket.OPEN) {
          return;
        }
        socket.send(JSON.stringify(payload));
        return;
      }
      await sendUdpLanFeedback(payload);
    },
    [inputToken, sessionId, streamId],
  );

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
      setDroppedBufferFrames(countersRef.current.droppedBufferFrames);
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
      setDecodeErrors(countersRef.current.decodeErrors);
      setStatus(`Falha ao decodificar chunk: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, []);

  const handleStats = useCallback((payload: UdpLanStatsEvent) => {
    if (activeTransportRef.current !== 'lan') return;
    setFpsAssembled(payload.fpsAssembled);
    setBitrateKbps(payload.bitrateKbps);
    setLossPct(payload.lossPct);
    setJitterMs(payload.jitterMs);
    setPendingFrames(payload.pendingFrames);
    setPacketsAccepted(payload.packetsAccepted);
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
      type: 'network_report',
      lossPct: payload.lossPct,
      jitterMs: payload.jitterMs,
      requestedBitrateKbps: Math.max(600, Math.trunc(payload.bitrateKbps * 0.9)),
      reason: 'network_degraded',
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
  }, [sendFeedback]);

  const handleFrame = useCallback((payload: UdpLanFrameEvent) => {
    if (activeTransportRef.current !== 'lan') return;
    const bytes = decodeBase64ToBytes(payload.payloadBase64);
    decodeEncodedChunk({
      flags: payload.flags,
      timestampUs: payload.timestampUs,
      payload: bytes,
    });
  }, [decodeEncodedChunk]);

  const connect = useCallback(async () => {
    if (!isAvailable) {
      setStatus('Player nativo disponivel apenas no runtime Tauri.');
      return;
    }
    if (lockConnectionToSession && !isSessionConnectAllowed) {
      setStatus('Conexao bloqueada: sessao precisa estar ACTIVE ou STARTING.');
      return;
    }
    if (inputTokenExpiresAt?.trim()) {
      const expiresAtMs = Date.parse(inputTokenExpiresAt);
      if (Number.isFinite(expiresAtMs) && expiresAtMs <= Date.now()) {
        setStatus('Token de stream expirado. Atualize a sinalizacao da sessao.');
        return;
      }
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
    if (needsLanValidation && (!Number.isFinite(inputPortParsed) || inputPortParsed <= 0 || inputPortParsed > 65535)) {
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

    try {
      await disconnect();

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
      setReconnectAttempts(0);
      inputSeqRef.current = 0;
      inputPendingRef.current = 0;
      inputSendChainRef.current = Promise.resolve();
      reconnectInFlightRef.current = false;
      lastRenderAtRef.current = performance.now();
      lastPayloadAtRef.current = performance.now();
      lastKeyframeRequestAtRef.current = 0;
      lastNetworkReportAtRef.current = 0;

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

        mouseMoveTimerRef.current = setInterval(() => {
          if (!inputConnectedRef.current || !inputFocusedRef.current) return;
          const delta = mouseDeltaRef.current;
          if (delta.dx === 0 && delta.dy === 0) return;
          const dx = delta.dx;
          const dy = delta.dy;
          mouseDeltaRef.current = { dx: 0, dy: 0 };
          sendInput({ type: 'mouse_move', dx, dy }, { dropIfBusy: true });
        }, 8);

        connectedRef.current = true;
        setConnected(true);
        setStatus('Conectado via LAN UDP. Aguardando frames...');
        return;
      }

      inputConnectedRef.current = false;
      setInputStatus('Input remoto via relay ainda nao habilitado neste MVP.');
      const relayEndpoint = new URL(relayUrl!.trim());
      relayEndpoint.searchParams.set('role', 'client');
      relayEndpoint.searchParams.set('sessionId', sessionId!.trim());
      relayEndpoint.searchParams.set('streamId', streamId.trim());
      relayEndpoint.searchParams.set('token', token);
      relayEndpoint.searchParams.set('userId', relayUserId!.trim());
      const relaySocket = new WebSocket(relayEndpoint.toString());
      relaySocket.binaryType = 'arraybuffer';
      relaySocketRef.current = relaySocket;

      relaySocket.onopen = () => {
        connectedRef.current = true;
        setConnected(true);
        setStatus('Conectado via relay websocket. Aguardando frames...');
      };
      relaySocket.onclose = (event) => {
        relaySocketRef.current = null;
        if (!connectedRef.current) return;
        connectedRef.current = false;
        setConnected(false);
        setStatus(`Relay desconectado (code=${event.code}).`);
      };
      relaySocket.onerror = () => {
        setStatus('Erro no websocket relay.');
      };
      relaySocket.onmessage = (event) => {
        if (typeof event.data === 'string') {
          try {
            const parsed = JSON.parse(event.data) as { type?: string };
            if (parsed.type === 'relay.welcome') {
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
              const parsed = parseRelayFramePayload(arrayBuffer);
              if (!parsed) return;
              setPacketsAccepted((prev) => prev + 1);
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
          setPacketsAccepted((prev) => prev + 1);
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
      await disconnect();
    }
  }, [
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
    sendInput,
    sessionId,
    relayUrl,
    relayUserId,
    inputTokenExpiresAt,
    isSessionConnectAllowed,
    setupDecoder,
    streamId,
  ]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!connectedRef.current || !inputConnectedRef.current || !inputFocusedRef.current) return;
      const target = event.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA'].includes(target.tagName)) return;

      if (event.ctrlKey && event.shiftKey && event.code === 'KeyQ') {
        event.preventDefault();
        sendInput({ type: 'disconnect_hotkey' });
        disconnect();
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
      const shouldAskKeyframe = freezeMs >= 1200 && payloadGapMs <= 2500;
      if (shouldAskKeyframe && now - lastKeyframeRequestAtRef.current >= 900) {
        lastKeyframeRequestAtRef.current = now;
        sendFeedback({
          type: 'keyframe_request',
          freezeMs: Math.max(0, Math.trunc(freezeMs)),
          lossPct: network.lossPct,
          jitterMs: network.jitterMs,
          reason: 'decoder_freeze',
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
      }

      const shouldReconnect = freezeMs >= 4500 && payloadGapMs >= 3000;
      if (!shouldReconnect) return;
      if (reconnectInFlightRef.current) return;
      if (now - lastReconnectAtRef.current < 7000) return;

      if (inputTokenExpiresAt?.trim()) {
        const expiresAtMs = Date.parse(inputTokenExpiresAt);
        if (Number.isFinite(expiresAtMs) && expiresAtMs <= Date.now()) {
          setStatus('Reconexao automatica bloqueada: token expirado. Sincronize a sessao.');
          return;
        }
      }

      reconnectInFlightRef.current = true;
      lastReconnectAtRef.current = now;
      setReconnectAttempts((prev) => prev + 1);
      setStatus('Oscilacao detectada. Tentando reconexao limpa...');
      sendFeedback({
        type: 'reconnect',
        freezeMs: Math.max(0, Math.trunc(freezeMs)),
        lossPct: network.lossPct,
        jitterMs: network.jitterMs,
        reason: 'auto_reconnect',
      }).catch(() => undefined);

      connect()
        .catch((error) => {
          setStatus(
            `Falha na reconexao automatica: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        })
        .finally(() => {
          reconnectInFlightRef.current = false;
        });
    }, 400);

    return () => clearInterval(timer);
  }, [
    connect,
    inputTokenExpiresAt,
    isSessionConnectAllowed,
    lockConnectionToSession,
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
      disconnect();
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
          onClick={connect}
          disabled={connected || !isAvailable || (lockConnectionToSession && !isSessionConnectAllowed)}
        >
          {effectiveTransportMode === 'lan' ? 'Conectar player nativo (LAN)' : 'Conectar player nativo (Relay)'}
        </button>
        <button type="button" className={styles.ghost} onClick={disconnect} disabled={!connected}>
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
        {effectiveTransportMode === 'relay' ? ' Input remoto via relay sera adicionado em fase posterior.' : ''}
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
