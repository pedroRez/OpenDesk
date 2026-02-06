import type { FormEvent } from 'react';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { useToast } from '../../components/Toast';
import { devBypassCredits, request } from '../../lib/api';
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
  const isDevBypass = devBypassCredits;
  const presets = [
    { label: '30m', minutes: 30 },
    { label: '1h', minutes: 60 },
    { label: '2h', minutes: 120 },
  ];

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!pcId) return;
    if (!isAuthenticated || !user) {
      setError('Faca login para conectar.');
      return;
    }
    if (minutesPurchased < 1 || minutesPurchased > 240) {
      setError('Escolha entre 1 e 240 minutos.');
      return;
    }

    setLoading(true);
    setError('');
    try {
      const data = await request<
        | { status: 'ACTIVE'; sessionId: string | null; queueCount: number }
        | { status: 'WAITING'; position: number; queueCount: number }
      >(`/pcs/${pcId}/queue/join`, {
        method: 'POST',
        body: JSON.stringify({
          minutesPurchased,
        }),
      });

      if (data.status === 'ACTIVE' && data.sessionId) {
        toast.show('Sessao criada', 'success');
        navigate(`/client/session/${data.sessionId}`);
      } else if (data.status === 'WAITING') {
        toast.show(`Entrou na fila. Posicao: ${data.position}`, 'info');
        navigate(`/client/queue/${pcId}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao conectar');
    } finally {
      setLoading(false);
    }
  };

  const isCreditBlocked = error.toLowerCase().includes('saldo insuficiente');

  if (!pcId) {
    return <div className={styles.container}>Selecione um PC primeiro.</div>;
  }

  return (
    <div className={styles.container}>
      <h1>Conectar agora</h1>
      <p>Escolha a duracao para iniciar a sessao. Se o PC estiver ocupado, voce entra na fila.</p>
      {isDevBypass && <div className={styles.devNotice}>Modo teste: creditos ignorados.</div>}
      <form onSubmit={handleSubmit} className={styles.form}>
        {user ? (
          <p>
            Conectando como <strong>{user.displayName ?? user.username}</strong> ({user.email}).
          </p>
        ) : (
          <p>
            Faca login para conectar.{' '}
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
        {isCreditBlocked && (
          <div className={styles.creditCta}>
            <button type="button" className={styles.secondaryButton} disabled>
              {isDevBypass ? 'Modo teste ativado (DEV)' : 'Adicionar creditos (em breve)'}
            </button>
            <p className={styles.creditHint}>
              {isDevBypass
                ? 'O modo teste permite seguir o fluxo sem saldo.'
                : 'Sem creditos suficientes para reservar agora.'}
            </p>
          </div>
        )}
        <button type="submit" disabled={loading}>
          {loading ? 'Conectando...' : 'Conectar agora'}
        </button>
      </form>
    </div>
  );
}
