import type { FormEvent } from 'react';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { useToast } from '../../components/Toast';
import { request } from '../../lib/api';
import { useAuth } from '../../lib/auth';

import styles from './Reserve.module.css';

export default function Reserve() {
  const { pcId } = useParams();
  const navigate = useNavigate();
  const [minutesPurchased, setMinutesPurchased] = useState(60);
  const { user, isAuthenticated } = useAuth();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const toast = useToast();
  const presets = [
    { label: '30m', minutes: 30 },
    { label: '1h', minutes: 60 },
    { label: '2h', minutes: 120 },
  ];

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
      const data = await request<{ session: { id: string } }>('/sessions', {
        method: 'POST',
        body: JSON.stringify({
          pcId,
          clientUserId: user.id,
          minutesPurchased,
        }),
      });

      await request<{ session: { id: string } }>(`/sessions/${data.session.id}/start`, {
        method: 'POST',
      });

      toast.show('Sessao criada', 'success');
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
      <p>Escolha a duracao para iniciar a sessao imediatamente.</p>
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
        <div className={styles.presets}>
          {presets.map((preset) => (
            <button
              key={preset.minutes}
              type="button"
              className={`${styles.presetButton} ${
                minutesPurchased === preset.minutes ? styles.presetActive : ''
              }`}
              onClick={() => {
                setMinutesPurchased(preset.minutes);
                setError('');
              }}
            >
              {preset.label}
            </button>
          ))}
        </div>
        <label>
          Outro tempo (min)
          <input
            type="number"
            min={1}
            max={240}
            value={minutesPurchased}
            onChange={(event) => {
              setMinutesPurchased(Number(event.target.value));
              setError('');
            }}
          />
        </label>
        <p className={styles.summary}>Total: {minutesPurchased} minutos</p>
        {error && <span className={styles.error}>{error}</span>}
        <button type="submit" disabled={loading}>
          {loading ? 'Reservando...' : 'Reservar e iniciar'}
        </button>
      </form>
    </div>
  );
}
