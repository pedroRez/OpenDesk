import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { fetchJson } from '../../lib/api';
import { useAuth } from '../../lib/auth';

import styles from './Session.module.css';

type SessionDetail = {
  id: string;
  status: 'PENDING' | 'ACTIVE' | 'ENDED' | 'FAILED';
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
  const [session, setSession] = useState<SessionDetail | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [ending, setEnding] = useState(false);

  const loadSession = async () => {
    if (isLoading || !isAuthenticated || !id) {
      setLoading(false);
      return;
    }

    try {
      const data = await fetchJson<{ session: SessionDetail }>(`/sessions/${id}`);
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
      await fetchJson(`/sessions/${id}/end`, {
        method: 'POST',
        body: JSON.stringify({ failureReason: 'NONE' }),
      });
      await loadSession();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao encerrar');
    } finally {
      setEnding(false);
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

  return (
    <div className={styles.container}>
      <Link to="/client/marketplace">Voltar</Link>
      <h1>Sessao {session.id}</h1>
      <p>PC: {session.pc.name}</p>

      <div className={styles.meta}>
        <span className={styles.status}>Status: {session.status}</span>
        <span>Minutos restantes: {remainingMinutes}</span>
      </div>

      <div className={styles.actions}>
        <button
          type="button"
          onClick={() => navigate(`/client/connection/${session.id}`)}
          disabled={session.status !== 'ACTIVE'}
        >
          Conectar
        </button>
        <button type="button" onClick={handleEndSession} disabled={ending || session.status !== 'ACTIVE'}>
          {ending ? 'Encerrando...' : 'Encerrar Sessao'}
        </button>
      </div>

      {session.status === 'FAILED' && (
        <div className={styles.panel}>
          <strong>Sessao falhou.</strong>
          {session.failureReason && <p>Motivo: {session.failureReason}</p>}
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
          <h3>Conexao pronta</h3>
          <p>Use o botao Conectar para abrir a tela de instrucoes.</p>
        </div>
      )}

      {session.status === 'ENDED' && (
        <div className={styles.panel}>
          <strong>Sessao encerrada.</strong>
          <p>Se precisar, faca uma nova reserva.</p>
        </div>
      )}
    </div>
  );
}
