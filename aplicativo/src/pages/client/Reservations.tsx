import { useEffect, useState } from 'react';

import { request } from '../../lib/api';

import styles from './Reservations.module.css';

type Reservation = {
  id: string;
  startAt: string;
  endAt: string;
  status: 'SCHEDULED' | 'ACTIVE' | 'CANCELLED' | 'COMPLETED' | 'EXPIRED';
  pc: {
    name: string;
  };
};

const formatDateTime = (value: string) =>
  new Date(value).toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

export default function Reservations() {
  const [reservations, setReservations] = useState<Reservation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    request<{ reservations: Reservation[] }>('/my/reservations')
      .then((data) => {
        setReservations(data.reservations ?? []);
        setError('');
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Erro ao carregar agendamentos'))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return <div className={styles.container}>Carregando agendamentos...</div>;
  }

  if (error) {
    return <div className={styles.container}>{error}</div>;
  }

  return (
    <section className={styles.container}>
      <h1>Agendamentos</h1>
      {reservations.length === 0 && <p>Nenhum agendamento encontrado.</p>}
      <div className={styles.list}>
        {reservations.map((reservation) => (
          <div key={reservation.id} className={styles.card}>
            <div>
              <strong>{reservation.pc?.name ?? 'PC'}</strong>
              <p>
                {formatDateTime(reservation.startAt)} - {formatDateTime(reservation.endAt)}
              </p>
            </div>
            <span className={styles.status}>{reservation.status}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
