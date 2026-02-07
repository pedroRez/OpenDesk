import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { request, requestWithStatus } from '../../lib/api';
import { useToast } from '../../components/Toast';
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

export default function Connection() {
  const { id } = useParams();
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
  const navigate = useNavigate();
  const toast = useToast();

  useEffect(() => {
    if (!id) return;
    request<{ session: SessionDetail }>(`/sessions/${id}`)
      .then((data) => {
        setSession(data.session);
        setError('');
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Erro'))
      .finally(() => setLoading(false));
  }, [id]);

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
    setShowPairingModal(false);
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
        pcId: session.pc.id,
        token: tokenResponse.token,
        connectAddress: resolveResult.data.connectAddress,
      });

      if (session.status !== 'ACTIVE') {
        try {
          await request(`/sessions/${session.id}/start`, { method: 'POST' });
        } catch (error) {
          console.warn('[STREAM][CLIENT] start session fail', error);
        }
      }

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

      {session.status !== 'ACTIVE' && (
        <div className={styles.warning}>
          Esta sessao ainda nao esta ativa. Aguarde ou volte depois.
        </div>
      )}

      <div className={styles.panel}>
        <h3>Instrucoes (MVP)</h3>
        <ol>
          <li>Abra o Moonlight (ou outro cliente compativel).</li>
          <li>Selecione o host e inicie a conexao.</li>
          <li>Complete o pareamento se necessario.</li>
          <li>Inicie a conexao.</li>
        </ol>
        <button type="button" onClick={handleConnect} disabled={connecting}>
          {connecting ? 'Conectando...' : 'Tentar conectar'}
        </button>
        {installed === false && (
          <p className={styles.muted}>Moonlight nao detectado. Instale antes de conectar.</p>
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

      {showPairingModal && (
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

