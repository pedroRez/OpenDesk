import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { fetchJson } from '../../lib/api';

import styles from './Marketplace.module.css';

type PC = {
  id: string;
  name: string;
  level: string;
  pricePerHour: number;
  status: 'ONLINE' | 'OFFLINE' | 'BUSY';
  host?: { displayName: string } | null;
};

export default function Marketplace() {
  const [pcs, setPcs] = useState<PC[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');

  const loadPcs = async () => {
    try {
      const data = await fetchJson<PC[]>('/pcs');
      setPcs(data.filter((pc) => pc.status === 'ONLINE'));
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao carregar PCs');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadPcs();
    const intervalId = setInterval(loadPcs, 10000);
    return () => clearInterval(intervalId);
  }, []);

  return (
    <section className={styles.container}>
      <header className={styles.header}>
        <div>
          <h1>Marketplace</h1>
          <p>PCs online prontos para reserva imediata.</p>
        </div>
        <div className={styles.counter}>{pcs.length} PCs online</div>
      </header>

      {isLoading && <p>Carregando PCs...</p>}
      {error && <p>{error}</p>}

      <div className={styles.grid}>
        {pcs.map((pc) => (
          <article key={pc.id} className={styles.card}>
            <div>
              <h3>{pc.name}</h3>
              <p>Nivel {pc.level}</p>
              <p>Host: {pc.host?.displayName ?? 'N/A'}</p>
            </div>
            <div className={styles.cardFooter}>
              <span>R$ {pc.pricePerHour}/hora</span>
              <span className={styles.status}>{pc.status}</span>
            </div>
            <Link className={styles.button} to={`/client/pcs/${pc.id}`}>
              Ver detalhes
            </Link>
          </article>
        ))}
      </div>
    </section>
  );
}
