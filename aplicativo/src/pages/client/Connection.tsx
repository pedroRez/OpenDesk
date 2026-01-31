import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { fetchJson } from '../../lib/api';
import { getStreamingProvider } from '../../lib/streamingProvider';

import styles from './Connection.module.css';

type SessionDetail = {
  id: string;
  status: 'PENDING' | 'ACTIVE' | 'ENDED' | 'FAILED';
  pc: {
    name: string;
    connectionHost?: string | null;
    connectionPort?: number | null;
    connectionNotes?: string | null;
  };
};

export default function Connection() {
  const { id } = useParams();
  const [session, setSession] = useState<SessionDetail | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [showDetails, setShowDetails] = useState(false);
  const [providerMessage, setProviderMessage] = useState('');
  const [installed, setInstalled] = useState<boolean | null>(null);

  useEffect(() => {
    if (!id) return;
    fetchJson<{ session: SessionDetail }>(`/sessions/${id}`)
      .then((data) => {
        setSession(data.session);
        setError('');
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Erro'))
      .finally(() => setLoading(false));
  }, [id]);

  useEffect(() => {
    const provider = getStreamingProvider();
    provider.isInstalled().then(setInstalled).catch(() => setInstalled(false));
  }, []);

  const handleConnect = async () => {
    if (!id) return;
    const provider = getStreamingProvider();
    const result = await provider.connect(id);
    setProviderMessage(result.message ?? 'Abra seu cliente externo para conectar.');
  };

  if (loading) {
    return <div className={styles.container}>Carregando...</div>;
  }

  if (error || !session) {
    return <div className={styles.container}>Sessao nao encontrada.</div>;
  }

  return (
    <div className={styles.container}>
      <Link to={`/client/session/${session.id}`}>Voltar para sessao</Link>
      <h1>Conexao</h1>
      <p>PC: {session.pc.name}</p>

      {session.status !== 'ACTIVE' && (
        <div className={styles.warning}>
          Esta sessao ainda nao esta ativa. Aguarde ou volte depois.
        </div>
      )}

      <div className={styles.panel}>
        <h3>Instrucoes (MVP)</h3>
        <ol>
          <li>Abra o Moonlight (ou outro cliente compativel).</li>
          <li>Adicione o host com IP/DNS e porta informados.</li>
          <li>Complete o pareamento se necessario.</li>
          <li>Inicie a conexao.</li>
        </ol>
        <button type="button" onClick={handleConnect}>
          Tentar conectar
        </button>
        {installed === false && (
          <p className={styles.muted}>Moonlight nao detectado. Instale antes de conectar.</p>
        )}
        {providerMessage && <p className={styles.muted}>{providerMessage}</p>}
      </div>

      <div className={styles.panel}>
        <h3>Detalhes da conexao</h3>
        {!showDetails ? (
          <button type="button" onClick={() => setShowDetails(true)} className={styles.ghost}>
            Mostrar detalhes
          </button>
        ) : (
          <div className={styles.details}>
            <p>Host: {session.pc.connectionHost ?? 'Nao informado'}</p>
            <p>Porta: {session.pc.connectionPort ?? 47990}</p>
            {session.pc.connectionNotes && <p>Notas: {session.pc.connectionNotes}</p>}
          </div>
        )}
      </div>
    </div>
  );
}

