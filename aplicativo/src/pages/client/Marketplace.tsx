import type { FormEvent } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { useToast } from '../../components/Toast';
import { request } from '../../lib/api';
import { useAuth } from '../../lib/auth';

import styles from './Marketplace.module.css';

type PC = {
  id: string;
  name: string;
  level: string;
  pricePerHour: number;
  status: 'ONLINE' | 'OFFLINE' | 'BUSY';
  queueCount: number;
  host?: { displayName: string } | null;
  cpu?: string;
  ramGb?: number;
  gpu?: string;
  vramGb?: number;
  storageType?: string;
  internetUploadMbps?: number;
};

type ReservationSlot = {
  id: string;
  startAt: string;
  endAt: string;
  status: string;
};

type QueueJoinResponse =
  | { status: 'ACTIVE'; sessionId: string | null; queueCount: number }
  | { status: 'WAITING'; position: number; queueCount: number };

const DEFAULT_MINUTES = 60;

const formatDateInput = (value: Date) => {
  const year = value.getFullYear();
  const month = `${value.getMonth() + 1}`.padStart(2, '0');
  const day = `${value.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const formatTimeInput = (value: Date) => {
  const hours = `${value.getHours()}`.padStart(2, '0');
  const minutes = `${value.getMinutes()}`.padStart(2, '0');
  return `${hours}:${minutes}`;
};

const formatTime = (value: string) =>
  new Date(value).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

const formatDateLabel = (value: Date) =>
  value.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });

export default function Marketplace() {
  const [pcs, setPcs] = useState<PC[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [connectingPcId, setConnectingPcId] = useState<string | null>(null);
  const [schedulePc, setSchedulePc] = useState<PC | null>(null);
  const [scheduleDate, setScheduleDate] = useState(() => formatDateInput(new Date()));
  const [scheduleTime, setScheduleTime] = useState(() => {
    const now = new Date();
    now.setMinutes(0, 0, 0);
    now.setHours(now.getHours() + 1);
    return formatTimeInput(now);
  });
  const [scheduleDuration, setScheduleDuration] = useState(60);
  const [availability, setAvailability] = useState<ReservationSlot[]>([]);
  const [availabilityLoading, setAvailabilityLoading] = useState(false);
  const [scheduleError, setScheduleError] = useState('');
  const [scheduling, setScheduling] = useState(false);

  const { user, isAuthenticated } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();

  const loadPcs = async (showLoading = false) => {
    if (showLoading) {
      setIsLoading(true);
      setError('');
    }
    try {
      const data = await request<PC[]>('/pcs');
      setPcs(data);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao carregar PCs');
    } finally {
      if (showLoading) {
        setIsLoading(false);
      }
    }
  };

  useEffect(() => {
    loadPcs(true);
    const intervalId = setInterval(() => loadPcs(false), 12000);
    return () => clearInterval(intervalId);
  }, []);

  const statusCounts = useMemo(() => {
    return pcs.reduce(
      (acc, pc) => {
        acc.total += 1;
        if (pc.status === 'ONLINE') acc.online += 1;
        if (pc.status === 'BUSY') acc.busy += 1;
        if (pc.status === 'OFFLINE') acc.offline += 1;
        return acc;
      },
      { total: 0, online: 0, busy: 0, offline: 0 },
    );
  }, [pcs]);

  const handleConnectNow = async (pc: PC) => {
    if (!isAuthenticated || !user) {
      toast.show('Faca login para conectar.', 'info');
      navigate(`/login?next=${encodeURIComponent('/client/marketplace')}`);
      return;
    }

    setConnectingPcId(pc.id);
    try {
      const response = await request<QueueJoinResponse>(`/pcs/${pc.id}/queue/join`, {
        method: 'POST',
        body: JSON.stringify({ minutesPurchased: DEFAULT_MINUTES }),
      });

      setPcs((prev) =>
        prev.map((item) =>
          item.id === pc.id
            ? {
                ...item,
                queueCount: response.queueCount,
              }
            : item,
        ),
      );

      if (response.status === 'ACTIVE' && response.sessionId) {
        toast.show('Sessao criada. Conectando...', 'success');
        navigate(`/client/session/${response.sessionId}`);
        return;
      }

      if (response.status === 'WAITING') {
        toast.show(`Entrou na fila. Posicao: ${response.position}`, 'info');
        navigate(`/client/queue/${pc.id}`);
      }
    } catch (err) {
      toast.show(err instanceof Error ? err.message : 'Erro ao conectar', 'error');
    } finally {
      setConnectingPcId(null);
    }
  };

  const openSchedule = (pc: PC) => {
    if (!isAuthenticated || !user) {
      toast.show('Faca login para agendar.', 'info');
      navigate(`/login?next=${encodeURIComponent('/client/marketplace')}`);
      return;
    }
    setScheduleError('');
    setAvailability([]);
    setSchedulePc(pc);
  };

  const closeSchedule = () => {
    setSchedulePc(null);
    setScheduleError('');
  };

  const loadAvailability = async (pcId: string, date: string) => {
    setAvailabilityLoading(true);
    setScheduleError('');
    try {
      const data = await request<{ reservations: ReservationSlot[] }>(
        `/pcs/${pcId}/reservations/availability?date=${date}`,
      );
      setAvailability(data.reservations ?? []);
    } catch (err) {
      setScheduleError(err instanceof Error ? err.message : 'Erro ao carregar horarios.');
    } finally {
      setAvailabilityLoading(false);
    }
  };

  useEffect(() => {
    if (!schedulePc) return;
    loadAvailability(schedulePc.id, scheduleDate);
  }, [schedulePc, scheduleDate]);

  const handleScheduleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!schedulePc) return;

    const startAt = new Date(`${scheduleDate}T${scheduleTime}`);
    if (Number.isNaN(startAt.getTime())) {
      setScheduleError('Horario invalido.');
      return;
    }

    setScheduling(true);
    setScheduleError('');
    try {
      await request(`/pcs/${schedulePc.id}/reservations`, {
        method: 'POST',
        body: JSON.stringify({
          startAt: startAt.toISOString(),
          durationMin: scheduleDuration,
        }),
      });

      toast.show(
        `Reserva criada para ${formatDateLabel(startAt)} as ${formatTimeInput(startAt)}.`,
        'success',
      );
      closeSchedule();
    } catch (err) {
      setScheduleError(err instanceof Error ? err.message : 'Erro ao agendar');
    } finally {
      setScheduling(false);
    }
  };

  return (
    <section className={styles.container}>
      <header className={styles.header}>
        <div>
          <h1>Marketplace</h1>
          <p>Escolha um PC e conecte agora ou agende um horario.</p>
        </div>
        <div className={styles.counter}>
          {statusCounts.total} PCs | {statusCounts.online} online | {statusCounts.busy} ocupados
        </div>
      </header>

      {isLoading && <p>Carregando PCs...</p>}
      {error && (
        <div className={styles.error}>
          <div>
            <strong>Falha ao carregar PCs</strong>
            <p>{error}</p>
          </div>
          <button type="button" onClick={() => loadPcs(true)} className={styles.retryButton}>
            Tentar novamente
          </button>
        </div>
      )}
      {!isLoading && !error && pcs.length === 0 && (
        <div className={styles.empty}>Nenhum PC disponivel no momento. Tente novamente em alguns instantes.</div>
      )}

      <div className={styles.grid}>
        {pcs.map((pc) => {
          const isOffline = pc.status === 'OFFLINE';
          const isBusy = pc.status === 'BUSY';
          const statusClass =
            pc.status === 'ONLINE'
              ? styles.statusOnline
              : pc.status === 'BUSY'
                ? styles.statusBusy
                : styles.statusOffline;
          return (
            <article key={pc.id} className={styles.card}>
              <div>
                <div className={styles.cardHeader}>
                  <div>
                    <h3>{pc.name}</h3>
                    <p>Nivel {pc.level}</p>
                  </div>
                  <span className={`${styles.statusBadge} ${statusClass}`}>{pc.status}</span>
                </div>
                <p className={styles.hostLine}>Host: {pc.host?.displayName ?? 'N/A'}</p>
                <ul className={styles.specs}>
                  <li>
                    <strong>CPU:</strong> {pc.cpu ?? 'Nao informado'}
                  </li>
                  <li>
                    <strong>RAM:</strong> {pc.ramGb ? `${pc.ramGb} GB` : 'Nao informado'}
                  </li>
                  <li>
                    <strong>GPU:</strong>{' '}
                    {pc.gpu ? `${pc.gpu}${pc.vramGb ? ` (${pc.vramGb} GB VRAM)` : ''}` : 'Nao informado'}
                  </li>
                  <li>
                    <strong>Storage:</strong> {pc.storageType ?? 'Nao informado'}
                  </li>
                  <li>
                    <strong>Upload:</strong>{' '}
                    {pc.internetUploadMbps ? `${pc.internetUploadMbps} Mbps` : 'Nao informado'}
                  </li>
                </ul>
              </div>
              <div className={styles.cardMeta}>
                <span>R$ {pc.pricePerHour}/hora</span>
                <span className={styles.queue}>Fila: {pc.queueCount}</span>
              </div>
              <div className={styles.cardActions}>
                <button
                  type="button"
                  className={styles.primaryButton}
                  onClick={() => handleConnectNow(pc)}
                  disabled={isOffline || connectingPcId === pc.id}
                >
                  {connectingPcId === pc.id
                    ? 'Conectando...'
                    : isBusy
                      ? 'Conectar agora (entrar na fila)'
                      : 'Conectar agora'}
                </button>
                <button
                  type="button"
                  className={styles.secondaryButton}
                  onClick={() => openSchedule(pc)}
                  disabled={isOffline}
                >
                  Agendar
                </button>
                <Link className={styles.secondaryLink} to={`/client/pcs/${pc.id}`}>
                  Ver detalhes
                </Link>
              </div>
            </article>
          );
        })}
      </div>

      {schedulePc && (
        <div className={styles.scheduleOverlay} role="dialog" aria-modal="true">
          <div className={styles.schedulePanel}>
            <div className={styles.scheduleHeader}>
              <div>
                <h2>Agendar PC</h2>
                <p>{schedulePc.name}</p>
              </div>
              <button type="button" onClick={closeSchedule} className={styles.closeButton}>
                Fechar
              </button>
            </div>
            <form onSubmit={handleScheduleSubmit} className={styles.scheduleForm}>
              <label>
                Data
                <input
                  type="date"
                  value={scheduleDate}
                  onChange={(event) => setScheduleDate(event.target.value)}
                  required
                />
              </label>
              <label>
                Hora
                <input
                  type="time"
                  value={scheduleTime}
                  onChange={(event) => setScheduleTime(event.target.value)}
                  required
                />
              </label>
              <label>
                Duracao
                <select
                  value={scheduleDuration}
                  onChange={(event) => setScheduleDuration(Number(event.target.value))}
                >
                  <option value={30}>30 minutos</option>
                  <option value={60}>1 hora</option>
                  <option value={120}>2 horas</option>
                </select>
              </label>

              <div className={styles.availability}>
                <strong>Horarios indisponiveis</strong>
                {availabilityLoading && <span>Carregando horarios...</span>}
                {!availabilityLoading && availability.length === 0 && (
                  <span className={styles.muted}>Sem bloqueios neste dia.</span>
                )}
                {!availabilityLoading && availability.length > 0 && (
                  <ul>
                    {availability.map((slot) => (
                      <li key={slot.id}>
                        {formatTime(slot.startAt)} - {formatTime(slot.endAt)}
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {scheduleError && <div className={styles.errorInline}>{scheduleError}</div>}
              <button type="submit" className={styles.primaryButton} disabled={scheduling}>
                {scheduling ? 'Agendando...' : 'Confirmar agendamento'}
              </button>
            </form>
          </div>
        </div>
      )}
    </section>
  );
}
