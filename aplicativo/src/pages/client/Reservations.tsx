import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { request } from '../../lib/api';

import styles from './Reservations.module.css';

type Reservation = {
  id: string;
  startAt: string;
  endAt: string;
  status: 'SCHEDULED' | 'ACTIVE' | 'CANCELLED' | 'COMPLETED' | 'EXPIRED';
  pc: {
    name: string;
    cpu?: string;
    gpu?: string;
    ramGb?: number;
    host?: { displayName?: string | null };
  };
};

const formatDateLabel = (value: Date) =>
  value.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });

const formatTime = (value: string) =>
  new Date(value).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

const formatPeriod = (startAt: string, endAt: string) => {
  const start = new Date(startAt);
  const end = new Date(endAt);
  const dateLabel = formatDateLabel(start);
  return `${dateLabel} • ${formatTime(startAt)} → ${formatTime(endAt)}`;
};

const formatHostName = (host?: { displayName?: string | null } | null) =>
  host?.displayName ? host.displayName : 'Host';

const formatSpecs = (pc: Reservation['pc']) => {
  const parts = [
    pc.ramGb ? `${pc.ramGb}GB` : null,
    pc.cpu ?? null,
    pc.gpu ?? null,
  ].filter(Boolean);
  return parts.join(' • ');
};

const STATUS_LABELS: Record<Reservation['status'], string> = {
  SCHEDULED: 'Agendado',
  ACTIVE: 'Em andamento',
  CANCELLED: 'Cancelado',
  COMPLETED: 'Finalizado',
  EXPIRED: 'Expirado',
};

export default function Reservations() {
  const [reservations, setReservations] = useState<Reservation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const navigate = useNavigate();

  useEffect(() => {
    request<{ reservations: Reservation[] }>('/my/reservations')
      .then((data) => {
        setReservations(data.reservations ?? []);
        setError('');
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Erro ao carregar agendamentos'))
      .finally(() => setLoading(false));
  }, []);

  return (
    <section className={styles.container}>
      <header className={styles.header}>
        <div>
          <h1>Agendamentos</h1>
          <p className={styles.subtitle}>Seus acessos reservados</p>
        </div>
      </header>

      {loading && <div className={styles.state}>Carregando agendamentos...</div>}
      {!loading && error && <div className={styles.state}>{error}</div>}

      {!loading && !error && reservations.length === 0 && (
        <div className={styles.emptyState}>
          <div className={styles.emptyIcon}>📅</div>
          <strong>Nenhum agendamento encontrado</strong>
          <p>Agende um PC para garantir acesso em um horario especifico.</p>
          <button type="button" className={styles.primaryButton} onClick={() => navigate('/client/marketplace')}>
            Ir para Marketplace
          </button>
        </div>
      )}

      {!loading && !error && reservations.length > 0 && (
        <div className={styles.list}>
          {reservations.map((reservation) => {
            const canConnect = reservation.status === 'ACTIVE';
            const canCancel = reservation.status === 'SCHEDULED';
            return (
              <article key={reservation.id} className={styles.card}>
                <div className={styles.cardMain}>
                  <div className={styles.cardHeader}>
                    <strong>{reservation.pc?.name ?? 'PC'}</strong>
                    <span className={`${styles.status} ${styles[`status${reservation.status}`]}`}>
                      {STATUS_LABELS[reservation.status]}
                    </span>
                  </div>
                  {formatSpecs(reservation.pc) && (
                    <div className={styles.specs}>{formatSpecs(reservation.pc)}</div>
                  )}
                  <div className={styles.hostRow}>Host: {formatHostName(reservation.pc?.host)}</div>
                  <div className={styles.timeRow}>{formatPeriod(reservation.startAt, reservation.endAt)}</div>
                </div>
                <div className={styles.cardActions}>
                  <button type="button" className={styles.primaryButton} disabled={!canConnect}>
                    Conectar
                  </button>
                  <button type="button" className={styles.ghostButton} disabled={!canCancel}>
                    Cancelar
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
