import Link from 'next/link';

import { apiBaseUrl } from '../lib/api';

import styles from './page.module.css';

type PC = {
  id: string;
  name: string;
  level: string;
  pricePerHour: number;
  status: string;
  host: { displayName: string };
};

async function getPCs(): Promise<PC[]> {
  try {
    const response = await fetch(`${apiBaseUrl}/pcs`, { cache: 'no-store' });
    if (!response.ok) {
      return [];
    }
    return response.json();
  } catch {
    return [];
  }
}

export default async function HomePage() {
  const pcs = await getPCs();

  return (
    <main className={styles.container}>
      <header className={styles.header}>
        <div>
          <h1>OpenDesk</h1>
          <p>Marketplace de PCs remotos por hora.</p>
        </div>
      </header>

      <section className={styles.grid}>
        {pcs.map((pc) => (
          <article key={pc.id} className={styles.card}>
            <div>
              <h3>{pc.name}</h3>
              <p>Nível {pc.level}</p>
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
