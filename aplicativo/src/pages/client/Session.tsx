import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { useToast } from '../../components/Toast';
import { request } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { getStreamingProvider } from '../../lib/streamingProvider';

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
  const [showDetails, setShowDetails] = useState(false);
  const [providerMessage, setProviderMessage] = useState('');
  const [installed, setInstalled] = useState<boolean | null>(null);

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
    const provider = getStreamingProvider();
    provider.isInstalled().then(setInstalled).catch(() => setInstalled(false));
  }, []);

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
    if (!id) return;
    setConnecting(true);
    try {
      const provider = getStreamingProvider();
      const result = await provider.connect(id);
      setProviderMessage(result.message ?? 'Abra seu cliente externo para conectar.');
    } catch (err) {
      setProviderMessage(err instanceof Error ? err.message : 'Nao foi possivel iniciar a conexao.');
    } finally {
      setConnecting(false);
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
            <li>Adicione o host com IP/DNS e porta informados.</li>
            <li>Complete o pareamento se necessario.</li>
            <li>Inicie a conexao.</li>
          </ol>
          {installed === false && (
            <p className={styles.muted}>Moonlight nao detectado. Instale antes de conectar.</p>
          )}
          {providerMessage && <p className={styles.muted}>{providerMessage}</p>}
          <div className={styles.details}>
            {!showDetails ? (
              <button type="button" onClick={() => setShowDetails(true)} className={styles.ghostButton}>
                Mostrar detalhes
              </button>
            ) : (
              <div className={styles.detailsCard}>
                <p>Host: {session.pc.connectionHost ?? 'Nao informado'}</p>
                <p>Porta: {session.pc.connectionPort ?? 47990}</p>
                {session.pc.connectionNotes && <p>Notas: {session.pc.connectionNotes}</p>}
              </div>
            )}
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
