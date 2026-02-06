import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { useToast } from '../../components/Toast';
import { request, requestWithStatus } from '../../lib/api';
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

import styles from './Session.module.css';

type SessionDetail = {
  id: string;
  status: 'PENDING' | 'ACTIVE' | 'ENDED' | 'FAILED' | 'EXPIRED';
  minutesPurchased: number;
  minutesUsed: number;
  startAt: string | null;
  endAt: string | null;
  failureReason?: string | null;
  pc: {
    id?: string;
    name: string;
    connectionHost?: string | null;
    connectionPort?: number | null;
    connectionNotes?: string | null;
  };
};

export default function Session() {
  const { id } = useParams();
  const { isAuthenticated, isLoading } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const [session, setSession] = useState<SessionDetail | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [ending, setEnding] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [providerMessage, setProviderMessage] = useState('');
  const [installed, setInstalled] = useState<boolean | null>(null);
  const [connectHint, setConnectHint] = useState<string | null>(null);
  const [connectStage, setConnectStage] = useState<'idle' | 'checking' | 'pairing' | 'opening'>(
    'idle',
  );
  const [connectFailed, setConnectFailed] = useState(false);
  const [connectError, setConnectError] = useState('');
  const [connectErrorDetails, setConnectErrorDetails] = useState('');
  const [showConnectDetails, setShowConnectDetails] = useState(false);
  const [showPairingModal, setShowPairingModal] = useState(false);
  const [pairingRequired, setPairingRequired] = useState(false);
  const [pairingPin, setPairingPin] = useState('');
  const [pairingMessage, setPairingMessage] = useState('');
  const [pairAvailable, setPairAvailable] = useState(false);
  const [pairing, setPairing] = useState(false);
  const [lastConnectAddress, setLastConnectAddress] = useState<string | null>(null);
  const [showMoonlightHelp, setShowMoonlightHelp] = useState(false);
  const [moonlightHelpStatus, setMoonlightHelpStatus] = useState('');

  const loadSession = async () => {
    if (isLoading || !isAuthenticated || !id) {
      setLoading(false);
      return;
    }

    try {
      const data = await request<{ session: SessionDetail }>(`/sessions/${id}`);
      setSession(data.session);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao carregar sessao');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isLoading) return;
    loadSession();
    const intervalId = setInterval(loadSession, 10000);
    return () => clearInterval(intervalId);
  }, [id, isAuthenticated, isLoading]);

  useEffect(() => {
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
  }, []);

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

  const remainingMinutes = useMemo(() => {
    if (!session) return 0;
    if (session.endAt) {
      const diff = Math.ceil((new Date(session.endAt).getTime() - Date.now()) / 60000);
      return Math.max(0, diff);
    }
    return Math.max(0, session.minutesPurchased - session.minutesUsed);
  }, [session]);

  const handleEndSession = async () => {
    if (!id) return;
    setEnding(true);
    try {
      await request(`/sessions/${id}/end`, {
        method: 'POST',
        body: JSON.stringify({ failureReason: 'NONE' }),
      });
      toast.show('Sessao encerrada', 'success');
      navigate('/client/marketplace');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Erro ao encerrar';
      setError(message);
      toast.show(message, 'error');
    } finally {
      setEnding(false);
    }
  };

  const handleConnect = async () => {
    if (!id || !session?.pc?.id) return;
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
    setPairingRequired(false);
    setProviderMessage('Verificando Moonlight...');
    setConnectStage('checking');
    try {
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
      setProviderMessage('Preparando conexao...');

      const tokenResponse = await request<{ token: string; expiresAt: string }>('/stream/connect-token', {
        method: 'POST',
        body: JSON.stringify({ pcId: session.pc.id }),
      });
      console.log('[STREAM][CLIENT] token created', { pcId: session.pc.id, expiresAt: tokenResponse.expiresAt });

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
        toast.show(
          `Resolve falhou (status ${resolveResult.status}). ${resolveResult.errorMessage ?? ''}`.trim(),
          'error',
        );
        setConnectErrorDetails(
          `Resolve falhou (status ${resolveResult.status}). ${resolveResult.errorMessage ?? ''}`.trim(),
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
        pcId: session.pc.id,
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
      console.log('[STREAM][CLIENT] launching moonlight...');
      setLastConnectAddress(resolveResult.data.connectAddress);
      const launchResult = await launchMoonlight(resolveResult.data.connectAddress);
      if (launchResult.ok) {
        console.log('[STREAM][CLIENT] launch ok');
        setProviderMessage('Abrindo conexao...');
        setConnectStage('opening');
        setPairAvailable(false);
      } else {
        console.error('[STREAM][CLIENT] launch fail');
        setPairAvailable(launchResult.needsPair);
        if (launchResult.needsPair) {
          setProviderMessage('Este host ainda nao esta pareado. Siga as instrucoes.');
          setConnectError('Host nao pareado. Digite o PIN exibido no host.');
          setPairingRequired(true);
          setShowPairingModal(true);
        } else {
          setProviderMessage(launchResult.message ?? 'Nao foi possivel abrir o Moonlight automaticamente.');
          setConnectError('Nao foi possivel conectar. Verifique se o host esta ONLINE.');
        }
        setConnectErrorDetails(launchResult.message ?? '');
        setConnectFailed(true);
      }
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

  const handleSubmitPairing = async () => {
    if (!session?.pc?.id || !pairingPin.trim()) return;
    try {
      await request('/stream/pairing', {
        method: 'POST',
        body: JSON.stringify({ pcId: session.pc.id, pin: pairingPin.trim() }),
      });
      setPairingMessage('PIN enviado. Verifique o pareamento no Sunshine/Moonlight.');
      setPairingRequired(false);
    } catch (err) {
      setPairingMessage(err instanceof Error ? err.message : 'Falha ao enviar o PIN.');
    }
  };

  const handlePairMoonlight = async () => {
    if (!lastConnectAddress || pairing) return;
    setPairing(true);
    setProviderMessage('Pareando...');
    const result = await pairMoonlight(lastConnectAddress);
    if (result.ok) {
      setProviderMessage('Pareamento iniciado. Siga as instrucoes no Moonlight.');
      setPairAvailable(false);
      setShowPairingModal(false);
      setPairingRequired(false);
    } else {
      setProviderMessage(result.message ?? 'Falha ao parear.');
    }
    setPairing(false);
  };

  const handleRetryConnect = () => {
    setShowPairingModal(false);
    setPairingRequired(false);
    handleConnect();
  };

  if (isLoading) {
    return <div className={styles.container}>Carregando sessao...</div>;
  }

  if (!isAuthenticated) {
    return (
      <div className={styles.container}>
        <p>Faca login para ver sua sessao.</p>
        <Link to={`/login?next=/client/session/${id}`}>Entrar</Link>
      </div>
    );
  }

  if (loading) {
    return <div className={styles.container}>Carregando sessao...</div>;
  }

  if (error) {
    const display = error === 'Sem permissao' ? 'Voce nao tem acesso a esta sessao.' : error;
    return <div className={styles.container}>{display}</div>;
  }

  if (!session) {
    return <div className={styles.container}>Sessao nao encontrada.</div>;
  }

  const statusClass =
    session.status === 'ACTIVE'
      ? styles.statusActive
      : session.status === 'PENDING'
        ? styles.statusPending
        : session.status === 'FAILED' || session.status === 'EXPIRED'
          ? styles.statusFailed
          : styles.statusEnded;
  const isFailedOrExpired = session.status === 'FAILED' || session.status === 'EXPIRED';
  const connectStepIndex =
    connectStage === 'checking' ? 0 : connectStage === 'pairing' ? 1 : connectStage === 'opening' ? 2 : -1;

  const stepClass = (index: number) => {
    if (connectStepIndex < 0) return styles.stepPending;
    if (index < connectStepIndex) return styles.stepDone;
    if (index === connectStepIndex) return styles.stepActive;
    return styles.stepPending;
  };

  return (
    <div className={styles.container}>
      <Link to="/client/marketplace">Voltar</Link>
      <h1>Sessao {session.id}</h1>
      <p>PC: {session.pc.name}</p>

      <div className={styles.meta}>
        <span className={`${styles.statusBadge} ${statusClass}`}>Status: {session.status}</span>
        <span>Minutos restantes: {remainingMinutes}</span>
      </div>

      <div className={styles.actions}>
        <button
          type="button"
          onClick={handleConnect}
          disabled={session.status !== 'ACTIVE' || connecting}
        >
          {connecting ? 'Conectando...' : 'Conectar'}
        </button>
        <button type="button" onClick={handleEndSession} disabled={ending || session.status !== 'ACTIVE'}>
          {ending ? 'Encerrando...' : 'Encerrar Sessao'}
        </button>
      </div>

      {isFailedOrExpired && (
        <div className={styles.panel}>
          <strong>{session.status === 'EXPIRED' ? 'Sessao expirada.' : 'Sessao falhou.'}</strong>
          {session.failureReason && <p>Motivo: {session.failureReason}</p>}
          <button type="button" onClick={() => navigate('/client/marketplace')} className={styles.secondaryButton}>
            Voltar ao marketplace
          </button>
        </div>
      )}

      {session.status === 'PENDING' && (
        <div className={styles.panel}>
          <strong>Aguardando inicio/liberacao.</strong>
          <p>O host precisa ficar ONLINE para liberar a conexao.</p>
        </div>
      )}

      {session.status === 'ACTIVE' && (
        <div className={styles.panel}>
          <h3>Como conectar</h3>
          <ol className={styles.instructions}>
            <li>Abra o Moonlight (ou outro cliente compativel).</li>
            <li>Selecione o host e inicie a conexao.</li>
            <li>Complete o pareamento se necessario.</li>
            <li>Inicie a conexao.</li>
          </ol>
          {installed === false && (
            <p className={styles.muted}>
              Moonlight nao detectado. Configure o caminho em Configuracoes.
            </p>
          )}
          {connectStage !== 'idle' && (
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
              {import.meta.env.DEV && connectErrorDetails && (
                <>
                  <button
                    type="button"
                    className={styles.ghostButton}
                    onClick={() => setShowConnectDetails((prev) => !prev)}
                  >
                    {showConnectDetails ? 'Ocultar detalhes' : 'Ver detalhes'}
                  </button>
                  {showConnectDetails && <pre className={styles.errorDetails}>{connectErrorDetails}</pre>}
                </>
              )}
            </div>
          )}
          {pairAvailable && (
            <button type="button" onClick={handlePairMoonlight} className={styles.ghostButton} disabled={pairing}>
              {pairing ? 'Pareando...' : 'Parear'}
            </button>
          )}
          <button
            type="button"
            className={styles.ghostButton}
            onClick={() => {
              setPairingRequired(false);
              setShowPairingModal(true);
            }}
          >
            Inserir PIN de pareamento
          </button>
        </div>
      )}

      {showMoonlightHelp && (
        <div className={styles.panel}>
          <strong>Moonlight nao detectado.</strong>
          <p className={styles.muted}>
            O OpenDesk instalara/configurara automaticamente em producao. Em DEV, informe o caminho.
          </p>
          <div className={styles.actionsRow}>
            <button type="button" onClick={handleMoonlightBrowse}>
              Procurar...
            </button>
            <button type="button" onClick={handleMoonlightVerify} className={styles.ghostButton}>
              Verificar
            </button>
            <button type="button" onClick={handleMoonlightAutoDetect} className={styles.ghostButton}>
              Localizar automaticamente
            </button>
            <button type="button" onClick={() => navigate('/settings')} className={styles.ghostButton}>
              Abrir configuracoes
            </button>
          </div>
          {moonlightHelpStatus && <p className={styles.muted}>{moonlightHelpStatus}</p>}
        </div>
      )}

      {showPairingModal && (
        <div className={styles.modalOverlay} role="dialog" aria-modal="true">
          <div className={styles.modal}>
            <div>
              <h3>Pareamento assistido</h3>
              <p className={styles.muted}>
                Se o Sunshine/Moonlight solicitar um PIN, informe abaixo para registrar o pareamento.
              </p>
              {pairingRequired && (
                <p className={styles.muted}>
                  Este host ainda nao esta pareado. Um PIN sera solicitado pelo Sunshine.
                </p>
              )}
            </div>
            <label className={styles.modalField}>
              PIN
              <input
                value={pairingPin}
                onChange={(event) => setPairingPin(event.target.value)}
                placeholder="Ex.: 1234"
              />
            </label>
            {pairingMessage && <p className={styles.muted}>{pairingMessage}</p>}
            <div className={styles.modalActions}>
              <button type="button" onClick={handleSubmitPairing}>
                Enviar PIN
              </button>
              <button type="button" onClick={handleRetryConnect} className={styles.secondaryButton}>
                Tentar novamente
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowPairingModal(false);
                  setPairingRequired(false);
                }}
                className={styles.secondaryButton}
              >
                Fechar
              </button>
            </div>
          </div>
        </div>
      )}

      {session.status === 'ENDED' && (
        <div className={styles.panel}>
          <strong>Sessao encerrada.</strong>
          <p>Se precisar, faca uma nova reserva.</p>
          <button type="button" onClick={() => navigate('/client/marketplace')} className={styles.secondaryButton}>
            Voltar ao marketplace
          </button>
        </div>
      )}
    </div>
  );
}
