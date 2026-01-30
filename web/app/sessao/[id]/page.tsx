'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';

import { fetchJson } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';

import styles from './page.module.css';

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

export default function SessionPage({ params }: { params: { id: string } }) {
  const { isAuthenticated, isLoading } = useAuth();
  const [session, setSession] = useState<SessionDetail | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const loadSession = async () => {
    if (isLoading || !isAuthenticated) {
      setLoading(false);
      return;
    }

    try {
      const data = await fetchJson<{ session: SessionDetail }>(`/sessions/${params.id}`);
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
  }, [params.id, isAuthenticated, isLoading]);

  const remainingMinutes = useMemo(() => {
    if (!session) return 0;
    if (session.endAt) {
      const diff = Math.ceil((new Date(session.endAt).getTime() - Date.now()) / 60000);
      return Math.max(0, diff);
    }
    return Math.max(0, session.minutesPurchased - session.minutesUsed);
  }, [session]);

  if (isLoading) {
    return <div className={styles.container}>Carregando sessao...</div>;
  }

  if (!isAuthenticated) {
    return (
      <div className={styles.container}>
        <p>Faca login para ver sua sessao.</p>
        <Link href={`/login?next=/sessao/${params.id}`}>Entrar</Link>
      </div>
    );
  }
  if (loading) {
    return <div className={styles.container}>Carregando sessao...</div>;
  }

  if (error) {
    const display =
      error === 'Sem permissao'
        ? 'Voce nao tem acesso a esta sessao.'
        : error;
    return <div className={styles.container}>{display}</div>;
  }

  if (!session) {
    return <div className={styles.container}>Sessao nao encontrada.</div>;
  }

  return (
    <div className={styles.container}>
      <Link href="/">Voltar</Link>
      <h1>Sessao {session.id}</h1>
      <p>PC: {session.pc.name}</p>

      <div className={styles.meta}>
        <span className={styles.status}>Status: {session.status}</span>
        <span>Minutos restantes: {remainingMinutes}</span>
      </div>

      <div className={styles.panel}>
        <h3>Dados de conexao</h3>
        <p>Host: {session.pc.connectionHost ?? 'Nao informado'}</p>
        <p>Porta: {session.pc.connectionPort ?? 47990}</p>
        {session.pc.connectionNotes && <p>Notas: {session.pc.connectionNotes}</p>}
      </div>

      {session.status === 'FAILED' && (
        <div className={styles.panel}>
          <strong>Sessao falhou.</strong>
          {session.failureReason && <p>Motivo: {session.failureReason}</p>}
          <Link href="/docs/falhas">Ver como funciona creditos e falhas</Link>
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
          <h3>Como conectar (Moonlight)</h3>
          <p>Use os dados de conexao acima no Moonlight.</p>
          <ol className={styles.steps}>
            <li>Abra o Moonlight.</li>
            <li>Adicione o host com IP/DNS e porta informados.</li>
            <li>Complete o pareamento, se necessario.</li>
            <li>Inicie a conexao.</li>
          </ol>
          <Link className={styles.linkButton} href="/docs/cliente">
            Abrir instrucoes completas
          </Link>
        </div>
      )}

      {session.status === 'ENDED' && (
        <div className={styles.panel}>
          <strong>Sessao encerrada.</strong>
          <p>Se precisar, faca uma nova reserva.</p>
        </div>
      )}

      <Link className={styles.linkButton} href="/docs/cliente">
        Abrir instrucoes completas
      </Link>
    </div>
  );
}
