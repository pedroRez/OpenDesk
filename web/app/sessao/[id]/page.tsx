import Link from 'next/link';

import { apiBaseUrl } from '../../../lib/api';

import styles from './page.module.css';

type SessionDetail = {
  id: string;
  status: string;
  minutesPurchased: number;
  minutesUsed: number;
  endAt: string | null;
  pc: { name: string };
};

async function getSession(id: string): Promise<SessionDetail | null> {
  const response = await fetch(`${apiBaseUrl}/sessions/${id}`, { cache: 'no-store' });
  if (!response.ok) return null;
  const data = await response.json();
  return data.session;
}

export default async function SessionPage({ params }: { params: { id: string } }) {
  const session = await getSession(params.id);

  if (!session) {
    return <div className={styles.container}>Sessão não encontrada.</div>;
  }

  return (
    <div className={styles.container}>
      <Link href="/">← Voltar</Link>
      <h1>Sessão {session.id}</h1>
      <p>PC: {session.pc.name}</p>
      <p>Status: {session.status}</p>
      <div className={styles.panel}>
        <h3>Conectar (MVP)</h3>
        <p>
          Use o token abaixo e abra o cliente remoto. Streaming ainda não está
          implementado.
        </p>
        <code className={styles.token}>TOKEN-{session.id.slice(0, 6)}</code>
        <ol>
          <li>Abra o cliente OpenDesk.</li>
          <li>Insira o token acima.</li>
          <li>Conecte-se ao PC remoto.</li>
        </ol>
      </div>
    </div>
  );
}
