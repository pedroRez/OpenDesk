import type { FormEvent } from 'react';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { fetchJson } from '../../lib/api';
import { useAuth } from '../../lib/auth';

import styles from './Reserve.module.css';

export default function Reserve() {
  const { pcId } = useParams();
  const navigate = useNavigate();
  const [quantity, setQuantity] = useState(1);
  const [unit, setUnit] = useState<'HOURS' | 'MINUTES'>('HOURS');
  const { user, isAuthenticated } = useAuth();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const minutesPurchased = unit === 'HOURS' ? quantity * 60 : quantity;

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!pcId) return;
    if (!isAuthenticated || !user) {
      setError('Faca login para reservar.');
      return;
    }
    if (minutesPurchased < 1 || minutesPurchased > 240) {
      setError('Escolha entre 1 e 240 minutos.');
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
          minutesPurchased,
        }),
      });

      await fetchJson<{ session: { id: string } }>(`/sessions/${data.session.id}/start`, {
        method: 'POST',
      });

      navigate(`/client/session/${data.session.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao reservar');
    } finally {
      setLoading(false);
    }
  };

  if (!pcId) {
    return <div className={styles.container}>Selecione um PC primeiro.</div>;
  }

  return (
    <div className={styles.container}>
      <h1>Reserva rapida</h1>
      <p>Escolha minutos ou horas para iniciar a sessao imediatamente.</p>
      <form onSubmit={handleSubmit} className={styles.form}>
        {user ? (
          <p>
            Reservando como <strong>{user.name}</strong> ({user.email}).
          </p>
        ) : (
          <p>
            Faca login para reservar.{' '}
            <Link to={`/login?next=${encodeURIComponent(`/client/reserve/${pcId}`)}`}>Entrar</Link>
          </p>
        )}
        <div className={styles.row}>
          <label>
            Quantidade
            <input
              type="number"
              min={1}
              max={unit === 'HOURS' ? 4 : 240}
              value={quantity}
              onChange={(event) => setQuantity(Number(event.target.value))}
            />
          </label>
          <label>
            Unidade
            <select value={unit} onChange={(event) => setUnit(event.target.value as 'HOURS' | 'MINUTES')}>
              <option value="HOURS">Horas</option>
              <option value="MINUTES">Minutos</option>
            </select>
          </label>
        </div>
        <p className={styles.summary}>Total: {minutesPurchased} minutos</p>
        {error && <span className={styles.error}>{error}</span>}
        <button type="submit" disabled={loading}>
          {loading ? 'Reservando...' : 'Reservar e iniciar'}
        </button>
      </form>
    </div>
  );
}
