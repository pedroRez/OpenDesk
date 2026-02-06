'use client';

import Link from 'next/link';
import { useSearchParams, useRouter } from 'next/navigation';
import { useState } from 'react';

import { fetchJson } from '../../lib/api';
import { useAuth } from '../../lib/auth';

import styles from './page.module.css';

export default function ReservaPage() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pcId = searchParams.get('pcId');
  const [hours, setHours] = useState(1);
  const { user, isAuthenticated } = useAuth();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!pcId) return;
    if (!isAuthenticated || !user) {
      setError('Faca login para reservar.');
      return;
    }

    setLoading(true);
    setError('');
    try {
      const data = await fetchJson<{ session: { id: string } }>('/sessions', {
        method: 'POST',
        body: JSON.stringify({
          pcId,
          clientUserId: user.id,
          minutesPurchased: hours * 60,
        }),
      });
      router.push(`/sessao/${data.session.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro');
    } finally {
      setLoading(false);
    }
  };

  if (!pcId) {
    return <div className={styles.container}>Selecione um PC primeiro.</div>;
  }

  return (
    <div className={styles.container}>
      <h1>Reserva rápida</h1>
      <p>Escolha a quantidade de horas (1 a 4) para a sessão.</p>
      <form onSubmit={handleSubmit} className={styles.form}>
        {user ? (
          <p>Reservando como {user.displayName ?? user.username} ({user.email}).</p>
        ) : (
          <p>
            Faca login para reservar.{' '}
            <Link href={`/login?next=/reserva?pcId=${pcId}`}>Entrar</Link>
          </p>
        )}
        <label>
          Horas
          <input
            type="number"
            min={1}
            max={4}
            value={hours}
            onChange={(event) => setHours(Number(event.target.value))}
          />
        </label>
        {error && <span className={styles.error}>{error}</span>}
        <button type="submit" disabled={loading}>
          {loading ? 'Reservando...' : 'Reservar'}
        </button>
      </form>
    </div>
  );
}
