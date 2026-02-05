import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { useToast } from '../../components/Toast';
import { request, requestWithStatus } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { isMoonlightAvailable, launchMoonlight, detectMoonlightPath } from '../../lib/moonlightLauncher';
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
  const [connectStatus, setConnectStatus] = useState<'idle' | 'preparing' | 'opening' | 'failed'>(
    'idle',
  );
  const [showPairingModal, setShowPairingModal] = useState(false);
  const [pairingPin, setPairingPin] = useState('');
  const [pairingMessage, setPairingMessage] = useState('');
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
    } else {
      console.log('[PATH] autodetect moonlight fail');
      setMoonlightHelpStatus('Nao encontrado. Use "Procurar...".');
    }
  };

  const handleMoonlightAutoDetect = async () => {
    const detected = await detectMoonlightPath();
    if (detected) {
      console.log('[PATH] autodetect moonlight ok', { path: detected });
      setMoonlightHelpStatus('Encontrado automaticamente');
      setInstalled(true);
    } else {
      console.log('[PATH] autodetect moonlight fail');
      setMoonlightHelpStatus('Nao encontramos o Moonlight nas pastas padrao.');
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
    if (installed === false) {
      setProviderMessage('Moonlight nao encontrado. Configure o caminho em Configuracoes.');
      setConnectStatus('failed');
      setShowMoonlightHelp(true);
      return;
    }
    if (connecting) {
      console.log('[STREAM][CLIENT] connect lock active');
      return;
    }
    setConnecting(true);
    setConnectStatus('preparing');
    try {
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
        } else {
          setProviderMessage(
            `Falha ao resolver conexao (status ${resolveResult.status}). ${resolveResult.errorMessage ?? ''}`.trim(),
          );
        }
        toast.show(
          `Resolve falhou (status ${resolveResult.status}). ${resolveResult.errorMessage ?? ''}`.trim(),
          'error',
        );
        setConnectStatus('failed');
        return;
      }

      console.log('[STREAM][CLIENT] resolve ok', {
        pcName: resolveResult.data.pcName,
        status: resolveResult.status,
      });
      setConnectHint(resolveResult.data.connectHint ?? null);

      setConnectStatus('opening');
      console.log('[STREAM][CLIENT] launching moonlight...');
      const launched = await launchMoonlight(resolveResult.data.connectAddress);
      if (launched) {
        console.log('[STREAM][CLIENT] launch ok');
        setProviderMessage('Abrindo Moonlight para conectar...');
      } else {
        console.error('[STREAM][CLIENT] launch fail');
        setProviderMessage('Nao foi possivel abrir o Moonlight automaticamente.');
        setConnectStatus('failed');
      }
    } catch (err) {
      console.error('[STREAM][CLIENT] token/resolve fail', err);
      setProviderMessage(err instanceof Error ? err.message : 'Nao foi possivel iniciar a conexao.');
      setConnectStatus('failed');
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
    } catch (err) {
      setPairingMessage(err instanceof Error ? err.message : 'Falha ao enviar o PIN.');
    }
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
          {connectStatus === 'preparing' && <p className={styles.muted}>Preparando conexao...</p>}
          {connectStatus === 'opening' && <p className={styles.muted}>Abrindo Moonlight...</p>}
          {connectStatus === 'failed' && (
            <p className={styles.muted}>Falha ao conectar. Tente novamente.</p>
          )}
          {connectHint && <p className={styles.muted}>{connectHint}</p>}
          {providerMessage && <p className={styles.muted}>{providerMessage}</p>}
          <button type="button" className={styles.ghostButton} onClick={() => setShowPairingModal(true)}>
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
              <button type="button" onClick={() => setShowPairingModal(false)} className={styles.secondaryButton}>
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
