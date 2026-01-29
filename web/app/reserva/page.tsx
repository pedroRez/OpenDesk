'use client';

import { useSearchParams, useRouter } from 'next/navigation';
import { useState } from 'react';

import { apiBaseUrl } from '../../lib/api';

import styles from './page.module.css';

export default function ReservaPage() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pcId = searchParams.get('pcId');
  const [hours, setHours] = useState(1);
  const [userId, setUserId] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!pcId) return;

    setLoading(true);
    setError('');
    try {
      const response = await fetch(`${apiBaseUrl}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pcId,
          clientUserId: userId,
          minutesPurchased: hours * 60,
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error ?? 'Erro ao reservar');
      }
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
        <label>
          ID do usuário (mock)
          <input
            value={userId}
            onChange={(event) => setUserId(event.target.value)}
            placeholder="Informe o userId"
            required
          />
        </label>
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
