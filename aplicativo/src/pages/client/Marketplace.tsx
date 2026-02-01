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
  cpu?: string;
  ramGb?: number;
  gpu?: string;
  vramGb?: number;
  storageType?: string;
  internetUploadMbps?: number;
};

export default function Marketplace() {
  const [pcs, setPcs] = useState<PC[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');

  const loadPcs = async (showLoading = false) => {
    if (showLoading) {
      setIsLoading(true);
      setError('');
    }
    try {
      const data = await fetchJson<PC[]>('/pcs');
      setPcs(data.filter((pc) => pc.status === 'ONLINE'));
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
    const intervalId = setInterval(() => loadPcs(false), 10000);
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
        <div className={styles.empty}>Nenhum PC online no momento. Tente novamente em alguns instantes.</div>
      )}

      <div className={styles.grid}>
        {pcs.map((pc) => (
          <article key={pc.id} className={styles.card}>
            <div>
              <h3>{pc.name}</h3>
              <p>Nivel {pc.level}</p>
              <p>Host: {pc.host?.displayName ?? 'N/A'}</p>
              <ul className={styles.specs}>
                <li>
                  <strong>CPU:</strong> {pc.cpu ?? 'Nao informado'}
                </li>
                <li>
                  <strong>RAM:</strong> {pc.ramGb ? `${pc.ramGb} GB` : 'Nao informado'}
                </li>
                <li>
                  <strong>GPU:</strong>{' '}
                  {pc.gpu
                    ? `${pc.gpu}${pc.vramGb ? ` (${pc.vramGb} GB VRAM)` : ''}`
                    : 'Nao informado'}
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
            <div className={styles.cardFooter}>
              <span>R$ {pc.pricePerHour}/hora</span>
              <span className={styles.status}>{pc.status}</span>
            </div>
            <div className={styles.cardActions}>
              <Link className={styles.button} to={`/client/reserve/${pc.id}`}>
                Reservar
              </Link>
              <Link className={styles.secondaryLink} to={`/client/pcs/${pc.id}`}>
                Ver detalhes
              </Link>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
