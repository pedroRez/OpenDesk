import { useEffect, useMemo, useState } from 'react';
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

const formatDayLabel = (value: Date) =>
  value.toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit' });

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

const HOURS = Array.from({ length: 24 }, (_, idx) => idx);
const HOUR_HEIGHT = 48;

const getWeekStart = (value: Date) => {
  const date = new Date(value);
  const day = date.getDay();
  const diff = (day + 6) % 7; // Monday as first day
  date.setDate(date.getDate() - diff);
  date.setHours(0, 0, 0, 0);
  return date;
};

const addDays = (value: Date, days: number) => {
  const date = new Date(value);
  date.setDate(date.getDate() + days);
  return date;
};

const getMinutesFromStart = (value: Date) => value.getHours() * 60 + value.getMinutes();

export default function Reservations() {
  const [reservations, setReservations] = useState<Reservation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedReservation, setSelectedReservation] = useState<Reservation | null>(null);
  const navigate = useNavigate();

  const weekStart = useMemo(() => getWeekStart(new Date()), []);
  const days = useMemo(() => Array.from({ length: 7 }, (_, idx) => addDays(weekStart, idx)), [weekStart]);
  const weekEnd = useMemo(() => addDays(weekStart, 7), [weekStart]);

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
        <div className={styles.calendar}>
          <div className={styles.calendarHeader}>
            <div className={styles.timeHeader} />
            <div className={styles.daysHeader}>
              {days.map((day) => (
                <div key={day.toISOString()} className={styles.dayHeader}>
                  {formatDayLabel(day)}
                </div>
              ))}
            </div>
          </div>

          <div className={styles.calendarBody}>
            <div className={styles.timeColumn}>
              {HOURS.map((hour) => (
                <div key={hour} className={styles.timeSlot}>
                  {`${String(hour).padStart(2, '0')}:00`}
                </div>
              ))}
            </div>
            <div className={styles.daysGrid}>
              {days.map((day, dayIndex) => {
                const dayStart = new Date(day);
                const dayEnd = addDays(dayStart, 1);
                const dayReservations = reservations.filter((reservation) => {
                  const start = new Date(reservation.startAt);
                  const end = new Date(reservation.endAt);
                  return start < dayEnd && end > dayStart && start < weekEnd && end > weekStart;
                });

                return (
                  <div
                    key={day.toISOString()}
                    className={styles.dayColumn}
                    style={{ height: `${HOUR_HEIGHT * 24}px` }}
                  >
                    {dayReservations.map((reservation) => {
                      const start = new Date(reservation.startAt);
                      const end = new Date(reservation.endAt);
                      if (start < dayStart || start >= dayEnd) return null;
                      const minutesFromStart = getMinutesFromStart(start);
                      const durationMinutes = Math.max(
                        30,
                        Math.round((end.getTime() - start.getTime()) / 60000),
                      );
                      const top = (minutesFromStart / 60) * HOUR_HEIGHT;
                      const height = (durationMinutes / 60) * HOUR_HEIGHT;
                      return (
                        <button
                          key={reservation.id}
                          type="button"
                          className={`${styles.event} ${styles[`event${reservation.status}`]}`}
                          style={{ top: `${top}px`, height: `${height}px` }}
                          onClick={() => setSelectedReservation(reservation)}
                          aria-label={`Agendamento ${reservation.pc?.name ?? 'PC'} ${formatTime(
                            reservation.startAt,
                          )}`}
                        >
                          <strong>{reservation.pc?.name ?? 'PC'}</strong>
                          <span>{formatTime(reservation.startAt)} - {formatTime(reservation.endAt)}</span>
                        </button>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {selectedReservation && (
        <div className={styles.modalOverlay} role="dialog" aria-modal="true">
          <div className={styles.modal}>
            <div className={styles.modalHeader}>
              <strong>{selectedReservation.pc?.name ?? 'PC'}</strong>
              <button type="button" className={styles.ghostButton} onClick={() => setSelectedReservation(null)}>
                Fechar
              </button>
            </div>
            {formatSpecs(selectedReservation.pc) && (
              <div className={styles.specs}>{formatSpecs(selectedReservation.pc)}</div>
            )}
            <div className={styles.hostRow}>Host: {formatHostName(selectedReservation.pc?.host)}</div>
            <div className={styles.timeRow}>
              {formatPeriod(selectedReservation.startAt, selectedReservation.endAt)}
            </div>
            <div className={styles.modalActions}>
              <button type="button" className={styles.primaryButton} disabled={selectedReservation.status !== 'ACTIVE'}>
                Conectar
              </button>
              <button type="button" className={styles.ghostButton} disabled={selectedReservation.status !== 'SCHEDULED'}>
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
