import Link from 'next/link';

import { apiBaseUrl } from '../../../lib/api';

import styles from './page.module.css';

type PCDetail = {
  id: string;
  name: string;
  level: string;
  cpu: string;
  ramGb: number;
  gpu: string;
  vramGb: number;
  storageType: string;
  internetUploadMbps: number;
  pricePerHour: number;
  status: string;
  connectionHost?: string | null;
  connectionPort?: number | null;
  connectionNotes?: string | null;
  softwareLinks: { software: { name: string } }[];
};

async function getPC(id: string): Promise<PCDetail | null> {
  try {
    const response = await fetch(`${apiBaseUrl}/pcs/${id}`, { cache: 'no-store' });
    if (!response.ok) {
      return null;
    }
    return response.json();
  } catch {
    return null;
  }
}

export default async function PCPage({ params }: { params: { id: string } }) {
  const pc = await getPC(params.id);

  if (!pc) {
    return <div className={styles.container}>PC não encontrado.</div>;
  }

  return (
    <div className={styles.container}>
      <Link href="/">← Voltar</Link>
      <h1>{pc.name}</h1>
      <p>Status: {pc.status}</p>
      <div className={styles.specs}>
        <div>
          <strong>CPU:</strong> {pc.cpu}
        </div>
        <div>
          <strong>RAM:</strong> {pc.ramGb} GB
        </div>
        <div>
          <strong>GPU:</strong> {pc.gpu} ({pc.vramGb} GB VRAM)
        </div>
        <div>
          <strong>Storage:</strong> {pc.storageType}
        </div>
        <div>
          <strong>Upload:</strong> {pc.internetUploadMbps} Mbps
        </div>
      </div>
      <section>
        <h3>Softwares instalados</h3>
        <ul>
          {pc.softwareLinks.map((item) => (
            <li key={item.software.name}>{item.software.name}</li>
          ))}
        </ul>
      </section>
      <section>
        <h3>Dados de conexao</h3>
        <p>Host: {pc.connectionHost ?? 'Nao informado'}</p>
        <p>Porta: {pc.connectionPort ?? 47990}</p>
        {pc.connectionNotes && <p>Notas: {pc.connectionNotes}</p>}
      </section>
      <Link className={styles.button} href={`/reserva?pcId=${pc.id}`}>
        Reservar por R$ {pc.pricePerHour}/hora
      </Link>
    </div>
  );
}
