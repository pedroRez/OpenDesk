import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';

import { request, requestWithStatus } from '../../lib/api';
import { useToast } from '../../components/Toast';
import { useAuth } from '../../lib/auth';
import {
  isMoonlightAvailable,
  ensureMoonlightReady,
  launchMoonlight,
  detectMoonlightPath,
  pairMoonlight,
} from '../../lib/moonlightLauncher';
import { getMoonlightPath, setMoonlightPath } from '../../lib/moonlightSettings';
import { normalizeWindowsPath, pathExists } from '../../lib/pathUtils';
import { open } from '@tauri-apps/plugin-dialog';
import LanNativePlayer from '../../components/LanNativePlayer';
import {
  devStreamingLog,
  getStreamingMode,
  isMoonlightAllowed,
  resolveNativeTransport,
  type NativeTransportMode,
} from '../../lib/streamingMode';

import styles from './Connection.module.css';

type SessionDetail = {
  id: string;
  status: 'PENDING' | 'ACTIVE' | 'ENDED' | 'FAILED';
  pc: {
    id?: string;
    name: string;
    connectionHost?: string | null;
    connectionPort?: number | null;
    connectionNotes?: string | null;
  };
};

type StreamStartSignal = {
  sessionId: string;
  sessionStatus: 'PENDING' | 'ACTIVE' | 'ENDED' | 'FAILED';
  streamState: 'STARTING' | 'ACTIVE';
  host: string;
  videoPort: number;
  inputPort: number;
  streamId: string;
  token: string;
  tokenExpiresAt: string;
  connectAddress: string;
  transport?: {
    recommended?: 'RELAY_WS' | 'UDP_LAN';
    relay?: {
      mode: 'RELAY_WS';
      url: string;
      roleClient: 'client';
      roleHost: 'host';
      sessionId: string;
      streamId: string;
      token: string;
      tokenExpiresAt: string;
    } | null;
    lan?: {
      mode: 'UDP_LAN';
      host: string;
      videoPort: number;
      inputPort: number;
    } | null;
  } | null;
  fallback?: {
    provider: string;
    connectAddress?: string | null;
    connectHint?: string | null;
  } | null;
};

export default function Connection() {
  const { id } = useParams();
  const location = useLocation();
  const { user } = useAuth();
  const streamingMode = useMemo(() => getStreamingMode(), []);
  const moonlightEnabled = useMemo(() => isMoonlightAllowed(streamingMode), [streamingMode]);
  const autoConnect = useMemo(() => {
    return new URLSearchParams(location.search).get('auto') === '1';
  }, [location.search]);
  const [session, setSession] = useState<SessionDetail | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [providerMessage, setProviderMessage] = useState('');
  const [installed, setInstalled] = useState<boolean | null>(null);
  const [connectHint, setConnectHint] = useState<string | null>(null);
  const [connectStage, setConnectStage] = useState<'idle' | 'checking' | 'pairing' | 'opening'>('idle');
  const [connectFailed, setConnectFailed] = useState(false);
  const [connectError, setConnectError] = useState('');
  const [connectErrorDetails, setConnectErrorDetails] = useState('');
  const [showConnectDetails, setShowConnectDetails] = useState(false);
  const [pairAvailable, setPairAvailable] = useState(false);
  const [pairing, setPairing] = useState(false);
  const [lastConnectAddress, setLastConnectAddress] = useState<string | null>(null);
  const [showMoonlightHelp, setShowMoonlightHelp] = useState(false);
  const [moonlightHelpStatus, setMoonlightHelpStatus] = useState('');
  const [showPairingModal, setShowPairingModal] = useState(false);
  const [streamSignal, setStreamSignal] = useState<StreamStartSignal | null>(null);
  const [streamSignalLoading, setStreamSignalLoading] = useState(false);
  const [streamSignalError, setStreamSignalError] = useState('');
  const [forceNativeDisconnectKey, setForceNativeDisconnectKey] = useState(0);
  const [autoNativeConnectKey, setAutoNativeConnectKey] = useState(0);
  const [selectedNativeTransport, setSelectedNativeTransport] = useState<NativeTransportMode | null>(null);
  const [autoConnectRequested, setAutoConnectRequested] = useState(false);
  const lastSessionStatusRef = useRef<SessionDetail['status'] | null>(null);
  const navigate = useNavigate();
  const toast = useToast();

  const requestStreamSignal = async (sessionId: string): Promise<StreamStartSignal | null> => {
    setStreamSignalLoading(true);
    setStreamSignalError('');
    try {
      const signalResult = await requestWithStatus<StreamStartSignal>(`/sessions/${sessionId}/stream/start`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      if (!signalResult.ok || !signalResult.data) {
        setStreamSignal(null);
        setSelectedNativeTransport(null);
        setStreamSignalError(
          signalResult.errorMessage ?? `Falha ao iniciar stream proprio (status ${signalResult.status}).`,
        );
        devStreamingLog('signal_error', {
          mode: streamingMode,
          status: signalResult.status,
          error: signalResult.errorMessage ?? null,
        });
        return null;
      }
      devStreamingLog('signal_ok', {
        mode: streamingMode,
        sessionId: signalResult.data.sessionId,
        streamState: signalResult.data.streamState,
        recommended: signalResult.data.transport?.recommended ?? null,
        relay: Boolean(signalResult.data.transport?.relay?.url),
        lan: Boolean(signalResult.data.transport?.lan?.host ?? signalResult.data.host),
      });
      setStreamSignal(signalResult.data);
      setSession((current) =>
        current
          ? {
              ...current,
              status: signalResult.data?.sessionStatus ?? current.status,
            }
          : current,
      );
      return signalResult.data;
    } finally {
      setStreamSignalLoading(false);
    }
  };

  useEffect(() => {
    if (!id) return;
    let active = true;

    const loadSession = async (showLoading = false) => {
      if (showLoading) {
        setLoading(true);
      }
      try {
        const data = await request<{ session: SessionDetail }>(`/sessions/${id}`);
        if (!active) return;
        setSession(data.session);
        setError('');

        const previous = lastSessionStatusRef.current;
        const current = data.session.status;
        lastSessionStatusRef.current = current;
        const streamable = current === 'PENDING' || current === 'ACTIVE';
        const wasStreamable = previous === 'PENDING' || previous === 'ACTIVE';

        if (!streamable) {
          setStreamSignal(null);
          if (wasStreamable) {
            setForceNativeDisconnectKey((value) => value + 1);
          }
          return;
        }

        if (!streamSignal && !streamSignalLoading) {
          await requestStreamSignal(data.session.id);
        }
      } catch (err) {
        if (!active) return;
        setError(err instanceof Error ? err.message : 'Erro');
      } finally {
        if (showLoading && active) {
          setLoading(false);
        }
      }
    };

    loadSession(true).catch(() => undefined);
    const interval = setInterval(() => {
      loadSession(false).catch(() => undefined);
    }, 3000);

    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [id, streamSignal, streamSignalLoading]);

  useEffect(() => {
    if (!moonlightEnabled) {
      setInstalled(null);
      setShowMoonlightHelp(false);
      return;
    }
    isMoonlightAvailable()
      .then((available) => {
        setInstalled(available);
        if (!available) {
          setShowMoonlightHelp(true);
        }
      })
      .catch(() => {
        setInstalled(false);
        setShowMoonlightHelp(true);
      });
  }, [moonlightEnabled]);

  const handleMoonlightBrowse = async () => {
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: 'Executavel', extensions: ['exe'] }],
        defaultPath: 'Moonlight.exe',
      });
      if (typeof selected === 'string' && selected) {
        const normalized = normalizeWindowsPath(selected);
        setMoonlightPath(normalized);
        console.log('[PATH] selected moonlightPath=', normalized);
        setMoonlightHelpStatus('Moonlight selecionado.');
        setInstalled(true);
        setShowMoonlightHelp(false);
      }
    } catch (error) {
      console.warn('[PATH] moonlight picker fail', error);
      setMoonlightHelpStatus('Selecao disponivel apenas no app desktop.');
    }
  };

  const handleMoonlightVerify = async () => {
    const current = getMoonlightPath();
    if (current) {
      const exists = await pathExists(current);
      if (exists) {
        console.log('[PATH] verify moonlight ok', { path: current });
        setMoonlightHelpStatus('Detectado OK');
        setInstalled(true);
        setShowMoonlightHelp(false);
        return;
      }
      console.log('[PATH] verify moonlight fail', { path: current });
      setMoonlightHelpStatus('Nao encontrado');
    }
    const fallback = await detectMoonlightPath();
    if (fallback) {
      console.log('[PATH] autodetect moonlight ok', { path: fallback });
      setMoonlightHelpStatus('Encontrado automaticamente');
      setInstalled(true);
      setShowMoonlightHelp(false);
    } else {
      console.log('[PATH] autodetect moonlight fail');
      setMoonlightHelpStatus('Nao encontrado. Use "Procurar...".');
      setShowMoonlightHelp(true);
    }
  };

  const handleMoonlightAutoDetect = async () => {
    const detected = await detectMoonlightPath();
    if (detected) {
      console.log('[PATH] autodetect moonlight ok', { path: detected });
      setMoonlightHelpStatus('Encontrado automaticamente');
      setInstalled(true);
      setShowMoonlightHelp(false);
    } else {
      console.log('[PATH] autodetect moonlight fail');
      setMoonlightHelpStatus('Nao encontramos o Moonlight nas pastas padrao.');
      setShowMoonlightHelp(true);
    }
  };

  const describeNativeFailure = (reason: string): string => {
    if (reason === 'session_not_streamable') return 'Sessao fora de estado de streaming.';
    if (reason === 'signal_unavailable') return 'Falha ao sincronizar sinalizacao de stream.';
    if (reason.includes('no_transport') || reason.includes('missing')) {
      return 'Sinalizacao sem transporte interno valido (relay/lan).';
    }
    return 'Nao foi possivel iniciar o player interno.';
  };

  const prepareNativeConnection = async (
    modeForChoice: 'AUTO' | 'OPENDESK_ONLY',
  ): Promise<{ ok: boolean; reason: string }> => {
    const sessionSnapshot = session;
    if (!sessionSnapshot?.id) {
      return { ok: false, reason: 'missing_session' };
    }
    if (sessionSnapshot.status !== 'PENDING' && sessionSnapshot.status !== 'ACTIVE') {
      return { ok: false, reason: 'session_not_streamable' };
    }

    const signal = await requestStreamSignal(sessionSnapshot.id);
    if (!signal) {
      return { ok: false, reason: 'signal_unavailable' };
    }

    const transportDecision = resolveNativeTransport(signal, modeForChoice);
    devStreamingLog('native_transport_decision', {
      mode: modeForChoice,
      transport: transportDecision.transport,
      reason: transportDecision.reason,
      recommended: signal.transport?.recommended ?? null,
    });

    if (!transportDecision.transport) {
      return { ok: false, reason: transportDecision.reason };
    }

    setSelectedNativeTransport(transportDecision.transport);
    setConnectHint(signal.fallback?.connectHint ?? null);
    setConnectStage('opening');
    setProviderMessage(
      transportDecision.transport === 'relay'
        ? 'Player interno selecionado: Relay WS.'
        : 'Player interno selecionado: LAN UDP.',
    );
    setForceNativeDisconnectKey((value) => value + 1);
    setAutoNativeConnectKey((value) => value + 1);

    devStreamingLog('transport_selected', {
      mode: modeForChoice,
      transport: transportDecision.transport,
      reason: transportDecision.reason,
    });
    return { ok: true, reason: transportDecision.reason };
  };

  const runMoonlightFlow = async (sessionSnapshot: SessionDetail) => {
    setProviderMessage('Verificando Moonlight...');
    setConnectStage('checking');

    const moonlightReady = await ensureMoonlightReady();
    if (!moonlightReady.ok) {
      setInstalled(false);
      if (moonlightReady.reason === 'path_missing') {
        setProviderMessage('Moonlight nao encontrado. Configure o caminho em Configuracoes.');
        setConnectError('Moonlight nao encontrado. Configure o caminho.');
        setShowMoonlightHelp(true);
      } else {
        setProviderMessage('Nao foi possivel iniciar o Moonlight.');
        setConnectError('Nao foi possivel iniciar o Moonlight.');
      }
      setConnectFailed(true);
      return;
    }
    setInstalled(true);
    setShowMoonlightHelp(false);

    if (sessionSnapshot.status === 'PENDING') {
      const startResult = await requestWithStatus<{
        session: { status: SessionDetail['status'] };
      }>(`/sessions/${sessionSnapshot.id}/start`, { method: 'POST' });
      if (!startResult.ok || !startResult.data?.session?.status) {
        setProviderMessage(
          `Nao foi possivel iniciar a sessao para fallback Moonlight. ${startResult.errorMessage ?? ''}`.trim(),
        );
        setConnectError('Sessao nao pode iniciar para conexao.');
        setConnectErrorDetails(startResult.errorMessage ?? '');
        setConnectFailed(true);
        return;
      }
      setSession((current) =>
        current
          ? {
              ...current,
              status: startResult.data?.session?.status ?? current.status,
            }
          : current,
      );
    } else if (sessionSnapshot.status !== 'ACTIVE') {
      setProviderMessage('Sessao fora de estado de conexao.');
      setConnectError('Conexao bloqueada fora da sessao.');
      setConnectFailed(true);
      return;
    }

    setProviderMessage('Preparando conexao...');
    const tokenResponse = await request<{ token: string; expiresAt: string }>('/stream/connect-token', {
      method: 'POST',
      body: JSON.stringify({ pcId: sessionSnapshot.pc.id }),
    });
    console.log('[STREAM][CLIENT] token created', { pcId: sessionSnapshot.pc.id, expiresAt: tokenResponse.expiresAt });

    const resolveResult = await requestWithStatus<{
      connectAddress: string;
      connectHint?: string | null;
      pcName: string;
    }>('/stream/resolve', {
      method: 'POST',
      body: JSON.stringify({ token: tokenResponse.token }),
    });
    if (!resolveResult.ok || !resolveResult.data) {
      console.error('[STREAM][CLIENT] resolve fail', {
        status: resolveResult.status,
        error: resolveResult.errorMessage,
      });
      if (resolveResult.status === 409 && resolveResult.errorMessage?.toLowerCase().includes('endereco')) {
        setProviderMessage(
          'PC sem conexao cadastrada (host/porta). Abra o painel do host e salve a conexao.',
        );
        setConnectError('PC sem conexao cadastrada (host/porta).');
      } else {
        setProviderMessage(
          `Falha ao resolver conexao (status ${resolveResult.status}). ${resolveResult.errorMessage ?? ''}`.trim(),
        );
        setConnectError('Nao foi possivel conectar. Verifique se o host esta ONLINE.');
      }
      setConnectErrorDetails(
        `Resolve falhou (status ${resolveResult.status}). ${resolveResult.errorMessage ?? ''}`.trim(),
      );
      toast.show(
        `Resolve falhou (status ${resolveResult.status}). ${resolveResult.errorMessage ?? ''}`.trim(),
        'error',
      );
      setConnectFailed(true);
      return;
    }

    console.log('[STREAM][CLIENT] resolve ok', {
      pcName: resolveResult.data.pcName,
      status: resolveResult.status,
    });
    setConnectHint(resolveResult.data.connectHint ?? null);

    console.log('[STREAM][CLIENT] resolve payload', {
      pcId: sessionSnapshot.pc.id,
      token: tokenResponse.token,
      connectAddress: resolveResult.data.connectAddress,
    });

    if (!resolveResult.data.connectAddress) {
      setProviderMessage('Endereco de conexao invalido.');
      setConnectError('Endereco de conexao invalido.');
      setConnectErrorDetails('connectAddress vazio/invalid.');
      setConnectFailed(true);
      return;
    }

    setConnectStage('pairing');
    setProviderMessage('Verificando pareamento...');
    devStreamingLog('transport_selected', {
      mode: streamingMode,
      transport: 'moonlight',
      reason: 'moonlight_flow',
    });
    console.log('[STREAM][CLIENT] launching moonlight...');
    setLastConnectAddress(resolveResult.data.connectAddress);
    const launchResult = await launchMoonlight(resolveResult.data.connectAddress);
    if (launchResult.ok) {
      console.log('[STREAM][CLIENT] launch ok');
      setProviderMessage('Abrindo conexao...');
      setConnectStage('opening');
      setPairAvailable(false);
      return;
    }

    console.error('[STREAM][CLIENT] launch fail');
    setPairAvailable(launchResult.needsPair);
    if (launchResult.needsPair) {
      setProviderMessage('Este host ainda nao esta pareado. Siga as instrucoes.');
      setConnectError('Host nao pareado. Digite o PIN exibido no host.');
      setShowPairingModal(true);
    } else {
      setProviderMessage(launchResult.message ?? 'Nao foi possivel abrir o Moonlight automaticamente.');
      setConnectError('Nao foi possivel conectar. Verifique se o host esta ONLINE.');
    }
    setConnectErrorDetails(launchResult.message ?? '');
    setConnectFailed(true);
  };

  const handleConnect = async () => {
    const sessionSnapshot = session;
    if (!id || !sessionSnapshot?.pc?.id) return;
    if (connecting) {
      console.log('[STREAM][CLIENT] connect lock active');
      return;
    }
    setConnecting(true);
    setConnectFailed(false);
    setConnectError('');
    setConnectErrorDetails('');
    setShowConnectDetails(false);
    setPairAvailable(false);
    setShowPairingModal(false);
    setConnectStage('idle');
    setProviderMessage('');

    devStreamingLog('mode', {
      mode: streamingMode,
      sessionId: sessionSnapshot.id,
      sessionStatus: sessionSnapshot.status,
    });

    try {
      if (streamingMode === 'OPENDESK_ONLY') {
        const nativeResult = await prepareNativeConnection('OPENDESK_ONLY');
        if (!nativeResult.ok) {
          const message = describeNativeFailure(nativeResult.reason);
          setProviderMessage(message);
          setConnectError(message);
          setConnectErrorDetails(`Motivo: ${nativeResult.reason}`);
          setConnectFailed(true);
        }
        return;
      }

      if (streamingMode === 'AUTO') {
        const nativeResult = await prepareNativeConnection('AUTO');
        if (nativeResult.ok) return;

        if (nativeResult.reason === 'session_not_streamable') {
          const message = describeNativeFailure(nativeResult.reason);
          setProviderMessage(message);
          setConnectError(message);
          setConnectErrorDetails(`Motivo: ${nativeResult.reason}`);
          setConnectFailed(true);
          return;
        }

        devStreamingLog('fallback_reason', {
          mode: streamingMode,
          reason: nativeResult.reason,
          fallback: 'moonlight',
        });
      }

      if (!moonlightEnabled) {
        const message = 'Moonlight desativado para este modo de streaming.';
        setProviderMessage(message);
        setConnectError(message);
        setConnectErrorDetails('fallback_blocked_moonlight_disabled');
        setConnectFailed(true);
        return;
      }

      await runMoonlightFlow(sessionSnapshot);
    } catch (err) {
      console.error('[STREAM][CLIENT] token/resolve fail', err);
      setProviderMessage(err instanceof Error ? err.message : 'Nao foi possivel iniciar a conexao.');
      setConnectError('Nao foi possivel conectar. Verifique se o host esta ONLINE.');
      setConnectErrorDetails(err instanceof Error ? err.message : String(err ?? ''));
      setConnectFailed(true);
    } finally {
      setConnecting(false);
    }
  };

  useEffect(() => {
    setAutoConnectRequested(false);
  }, [session?.id]);

  useEffect(() => {
    if (!autoConnect || !session || autoConnectRequested) return;
    if (session.status !== 'PENDING' && session.status !== 'ACTIVE') return;
    setAutoConnectRequested(true);
    handleConnect();
  }, [autoConnect, autoConnectRequested, session, handleConnect]);

  const handlePairMoonlight = async () => {
    if (!lastConnectAddress || pairing) return;
    setPairing(true);
    setProviderMessage('Pareando...');
    const result = await pairMoonlight(lastConnectAddress);
    if (result.ok) {
      setProviderMessage('Pareamento iniciado. Siga as instrucoes no Moonlight.');
      setPairAvailable(false);
      setShowPairingModal(false);
    } else {
      setProviderMessage(result.message ?? 'Falha ao parear.');
    }
    setPairing(false);
  };

  const handleRetryConnect = () => {
    setShowPairingModal(false);
    handleConnect();
  };

  const connectStepIndex =
    connectStage === 'checking' ? 0 : connectStage === 'pairing' ? 1 : connectStage === 'opening' ? 2 : -1;

  const stepClass = (index: number) => {
    if (connectStepIndex < 0) return styles.stepPending;
    if (index < connectStepIndex) return styles.stepDone;
    if (index === connectStepIndex) return styles.stepActive;
    return styles.stepPending;
  };

  const effectiveNativeTransport = useMemo<NativeTransportMode>(() => {
    if (selectedNativeTransport) return selectedNativeTransport;
    if (!streamSignal) return 'lan';
    const decision = resolveNativeTransport(streamSignal, 'AUTO');
    return decision.transport ?? 'lan';
  }, [selectedNativeTransport, streamSignal]);

  const connectButtonLabel = connecting
    ? 'Conectando...'
    : streamingMode === 'OPENDESK_ONLY'
      ? 'Conectar com player interno'
      : streamingMode === 'MOONLIGHT_ONLY'
        ? 'Conectar com Moonlight'
        : 'Conectar (AUTO)';

  if (loading) {
    return <div className={styles.container}>Carregando...</div>;
  }

  if (error || !session) {
    return <div className={styles.container}>Sessao nao encontrada.</div>;
  }

  return (
    <div className={styles.container}>
      <Link to={`/client/session/${session.id}`}>Voltar para sessao</Link>
      <h1>Conexao</h1>
      <p>PC: {session.pc.name}</p>
      <p className={styles.muted}>Modo de streaming: {streamingMode}</p>

      {!['PENDING', 'ACTIVE'].includes(session.status) && (
        <div className={styles.warning}>
          Esta sessao nao esta em estado de conexao. Streaming proprio foi bloqueado.
        </div>
      )}

      <div className={styles.panel}>
        <h3>Player Interno OpenDesk</h3>
        <p className={styles.muted}>
          Streaming interno via Relay WS ou LAN UDP, sem abrir cliente externo.
        </p>
        <div className={styles.actionsRow}>
          <button
            type="button"
            onClick={() => {
              if (!session?.id) return;
              requestStreamSignal(session.id).catch((cause) => {
                setStreamSignalError(
                  cause instanceof Error ? cause.message : 'Falha ao sincronizar stream proprio.',
                );
              });
            }}
            disabled={streamSignalLoading || !['PENDING', 'ACTIVE'].includes(session.status)}
          >
            {streamSignalLoading ? 'Sincronizando stream...' : 'Sincronizar stream proprio'}
          </button>
        </div>
        {streamSignalError && <p className={styles.muted}>{streamSignalError}</p>}
        {streamSignal && (
          <p className={styles.muted}>
            Stream sinalizado: {streamSignal.streamState} | host {streamSignal.host}:{streamSignal.videoPort} |
            recomendado {streamSignal.transport?.recommended ?? 'UDP_LAN'} | selecionado {effectiveNativeTransport.toUpperCase()}
          </p>
        )}
        <LanNativePlayer
          transportMode={effectiveNativeTransport}
          defaultPort={streamSignal?.videoPort ?? session.pc.connectionPort ?? 5004}
          defaultInputHost={streamSignal?.host ?? session.pc.connectionHost ?? undefined}
          defaultInputPort={streamSignal?.inputPort ?? 5505}
          defaultStreamId={streamSignal?.streamId}
          defaultInputToken={streamSignal?.token}
          relayUrl={streamSignal?.transport?.relay?.url ?? null}
          relayUserId={user?.id ?? null}
          inputTokenExpiresAt={streamSignal?.tokenExpiresAt}
          sessionId={session.id}
          sessionState={
            streamSignal?.streamState ??
            (session.status === 'ACTIVE'
              ? 'ACTIVE'
              : session.status === 'PENDING'
                ? 'STARTING'
                : 'INACTIVE')
          }
          lockConnectionToSession
          forceDisconnectKey={forceNativeDisconnectKey}
          autoConnectKey={autoNativeConnectKey}
        />
      </div>

      <div className={styles.panel}>
        <h3>Conectar</h3>
        {streamingMode === 'OPENDESK_ONLY' && (
          <p className={styles.muted}>
            Este modo usa somente o player interno. Nao abre Moonlight automaticamente.
          </p>
        )}
        {streamingMode === 'AUTO' && (
          <p className={styles.muted}>
            AUTO: tenta player interno primeiro e usa Moonlight apenas como fallback.
          </p>
        )}
        {streamingMode === 'MOONLIGHT_ONLY' && (
          <ol>
            <li>Abra o Moonlight (ou outro cliente compativel).</li>
            <li>Selecione o host e inicie a conexao.</li>
            <li>Complete o pareamento se necessario.</li>
            <li>Inicie a conexao.</li>
          </ol>
        )}
        <button type="button" onClick={handleConnect} disabled={connecting}>
          {connectButtonLabel}
        </button>
        {moonlightEnabled && installed === false && (
          <p className={styles.muted}>Moonlight nao detectado. Instale antes de conectar.</p>
        )}
        {moonlightEnabled && connectStage !== 'idle' && (
          <ul className={styles.stepList}>
            <li className={`${styles.stepItem} ${stepClass(0)}`}>
              <span className={styles.stepDot} />
              Verificando Moonlight
            </li>
            <li className={`${styles.stepItem} ${stepClass(1)}`}>
              <span className={styles.stepDot} />
              Verificando pareamento
            </li>
            <li className={`${styles.stepItem} ${stepClass(2)}`}>
              <span className={styles.stepDot} />
              Abrindo conexao
            </li>
          </ul>
        )}
        {connectHint && <p className={styles.muted}>{connectHint}</p>}
        {providerMessage && <p className={styles.muted}>{providerMessage}</p>}
        {connectFailed && connectError && (
          <div className={styles.errorBox}>
            <p>{connectError}</p>
            <div className={styles.actionsRow}>
              <button type="button" onClick={handleConnect}>
                Tentar novamente
              </button>
            </div>
            {import.meta.env.DEV && connectErrorDetails && (
              <>
                <button
                  type="button"
                  className={styles.ghost}
                  onClick={() => setShowConnectDetails((prev) => !prev)}
                >
                  {showConnectDetails ? 'Ocultar detalhes' : 'Ver detalhes'}
                </button>
                {showConnectDetails && <pre className={styles.errorDetails}>{connectErrorDetails}</pre>}
              </>
            )}
          </div>
        )}
      </div>

      {moonlightEnabled && showMoonlightHelp && (
        <div className={styles.panel}>
          <strong>Moonlight nao detectado.</strong>
          <p className={styles.muted}>
            O OpenDesk instalara/configurara automaticamente em producao. Em DEV, informe o caminho.
          </p>
          <div className={styles.actionsRow}>
            <button type="button" onClick={handleMoonlightBrowse}>
              Procurar...
            </button>
            <button type="button" onClick={handleMoonlightVerify} className={styles.ghost}>
              Verificar
            </button>
            <button type="button" onClick={handleMoonlightAutoDetect} className={styles.ghost}>
              Localizar automaticamente
            </button>
            <button type="button" onClick={() => navigate('/settings')} className={styles.ghost}>
              Abrir configuracoes
            </button>
          </div>
          {moonlightHelpStatus && <p className={styles.muted}>{moonlightHelpStatus}</p>}
        </div>
      )}

      {moonlightEnabled && showPairingModal && (
        <div className={styles.modalOverlay} role="dialog" aria-modal="true">
          <div className={styles.modal}>
            <div>
              <h3>Pareamento necessario</h3>
              <p className={styles.muted}>
                Este host ainda nao esta pareado. Um PIN sera solicitado pelo Sunshine. Digite o PIN exibido no host.
              </p>
            </div>
            <div className={styles.modalActions}>
              {pairAvailable && (
                <button type="button" onClick={handlePairMoonlight} disabled={pairing}>
                  {pairing ? 'Pareando...' : 'Parear'}
                </button>
              )}
              <button type="button" onClick={handleRetryConnect} className={styles.ghost}>
                Tentar novamente
              </button>
              <button type="button" onClick={() => setShowPairingModal(false)} className={styles.ghost}>
                Fechar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

