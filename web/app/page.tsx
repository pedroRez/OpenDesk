'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

import { fetchJson } from '../lib/api';

import styles from './page.module.css';

type PC = {
  id: string;
  name: string;
  level: string;
  pricePerHour: number;
  status: string;
  host: { displayName: string };
};

export default function HomePage() {
  const [pcs, setPcs] = useState<PC[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');

  const loadPcs = async () => {
    try {
      const data = await fetchJson<PC[]>('/pcs');
      setPcs(data);
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
    <main className={styles.container}>
      <header className={styles.header}>
        <div>
          <h1>OpenDesk</h1>
          <p>Marketplace de PCs remotos por hora.</p>
        </div>
      </header>

      {isLoading && <p>Carregando PCs...</p>}
      {error && <p>{error}</p>}

      <section className={styles.grid}>
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
            <Link className={styles.button} href={`/pcs/${pc.id}`}>
              Ver detalhes
            </Link>
          </article>
        ))}
      </section>
    </main>
  );
}
