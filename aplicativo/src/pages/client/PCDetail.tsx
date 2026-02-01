import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { request } from '../../lib/api';

import styles from './PCDetail.module.css';

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

export default function PCDetail() {
  const { id } = useParams();
  const [pc, setPc] = useState<PCDetail | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!id) return;
    request<PCDetail>(`/pcs/${id}`)
      .then((data) => {
        setPc(data);
        setError('');
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Erro'))
      .finally(() => setLoading(false));
  }, [id]);

  if (loading) {
    return <div className={styles.container}>Carregando...</div>;
  }

  if (error || !pc) {
    return <div className={styles.container}>PC nao encontrado.</div>;
  }

  return (
    <div className={styles.container}>
      <Link to="/client/marketplace">Voltar</Link>
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
          {pc.softwareLinks?.length ? (
            pc.softwareLinks.map((item) => <li key={item.software.name}>{item.software.name}</li>)
          ) : (
            <li>Nenhum software listado.</li>
          )}
        </ul>
      </section>
      <section>
        <h3>Dados de conexao</h3>
        <p>Host: {pc.connectionHost ?? 'Nao informado'}</p>
        <p>Porta: {pc.connectionPort ?? 47990}</p>
        {pc.connectionNotes && <p>Notas: {pc.connectionNotes}</p>}
      </section>
      <Link className={styles.button} to={`/client/reserve/${pc.id}`}>
        Reservar por R$ {pc.pricePerHour}/hora
      </Link>
    </div>
  );
}
