import type { ReactNode } from 'react';
import Link from 'next/link';

import styles from './docs.module.css';

export default function DocsLayout({ children }: { children: ReactNode }) {
  return (
    <div className={styles.container}>
      <aside className={styles.sidebar}>
        <strong>Ajuda OpenDesk</strong>
        <nav className={styles.nav}>
          <Link href="/docs">Visao geral</Link>
          <Link href="/docs/cliente">Cliente (Moonlight)</Link>
          <Link href="/docs/host">Host (Sunshine)</Link>
          <Link href="/docs/rede">Rede e portas</Link>
          <Link href="/docs/falhas">Falhas e creditos</Link>
        </nav>
      </aside>
      <main className={styles.content}>{children}</main>
    </div>
  );
}
