import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { useToast } from '../../components/Toast';
import { request } from '../../lib/api';

import styles from './Queue.module.css';

type QueueInfo = {
  queueCount: number;
  position: number | null;
  status: 'WAITING' | 'PROMOTED' | 'ACTIVE' | null;
  sessionId: string | null;
};

const AUTO_SESSION_STORAGE_KEY = 'opendesk:lastAutoSessionId';

export default function Queue() {
  const { pcId } = useParams();
  const [queue, setQueue] = useState<QueueInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [leaving, setLeaving] = useState(false);
  const toast = useToast();
  const navigate = useNavigate();

  const loadQueue = async () => {
    if (!pcId) return;
    try {
      const data = await request<QueueInfo>(`/pcs/${pcId}/queue`);
      setQueue(data);
      setError('');
      if (data.sessionId && (data.status === 'PROMOTED' || data.status === 'ACTIVE')) {
        const lastAuto = localStorage.getItem(AUTO_SESSION_STORAGE_KEY);
        if (lastAuto !== data.sessionId) {
          localStorage.setItem(AUTO_SESSION_STORAGE_KEY, data.sessionId);
          toast.show('E sua vez! Conectando...', 'success');
          navigate(`/client/session/${data.sessionId}?auto=1`);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao carregar fila');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadQueue();
    const intervalId = setInterval(loadQueue, 10000);
    return () => clearInterval(intervalId);
  }, [pcId]);

  const handleLeave = async () => {
    if (!pcId) return;
    setLeaving(true);
    try {
      await request(`/pcs/${pcId}/queue/leave`, { method: 'POST' });
      toast.show('Voce saiu da fila.', 'success');
      navigate('/client/marketplace');
    } catch (err) {
      toast.show(err instanceof Error ? err.message : 'Erro ao sair da fila', 'error');
    } finally {
      setLeaving(false);
    }
  };

  if (!pcId) {
    return <div className={styles.container}>PC invalido.</div>;
  }

  if (loading) {
    return <div className={styles.container}>Carregando fila...</div>;
  }

  if (error) {
    return <div className={styles.container}>{error}</div>;
  }

  if (!queue || !queue.status) {
    return (
      <div className={styles.container}>
        <p>Voce nao esta na fila deste PC.</p>
        <Link to="/client/marketplace">Voltar ao marketplace</Link>
      </div>
    );
  }

  return (
    <div className={styles.container}>
      <Link to="/client/marketplace">Voltar</Link>
      <h1>Fila do PC</h1>
      <div className={styles.card}>
        <p>
          Status:{' '}
          {queue.status === 'WAITING'
            ? 'Aguardando'
            : queue.status === 'PROMOTED'
              ? 'Chamando'
              : 'Ativo'}
        </p>
        <p>Fila total: {queue.queueCount}</p>
        {queue.position !== null && <p>Sua posicao: {queue.position}</p>}
      </div>
      <button type="button" onClick={handleLeave} disabled={leaving}>
        {leaving ? 'Saindo...' : 'Sair da fila'}
      </button>
    </div>
  );
}
