import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { request } from '../../lib/api';
import { isMoonlightAvailable, launchMoonlight } from '../../lib/moonlightLauncher';

import styles from './Connection.module.css';

type SessionDetail = {
  id: string;
  status: 'PENDING' | 'ACTIVE' | 'ENDED' | 'FAILED';
  pc: {
    id?: string;
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
  const [connecting, setConnecting] = useState(false);
  const [providerMessage, setProviderMessage] = useState('');
  const [installed, setInstalled] = useState<boolean | null>(null);
  const [connectHint, setConnectHint] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    request<{ session: SessionDetail }>(`/sessions/${id}`)
      .then((data) => {
        setSession(data.session);
        setError('');
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Erro'))
      .finally(() => setLoading(false));
  }, [id]);

  useEffect(() => {
    isMoonlightAvailable().then(setInstalled).catch(() => setInstalled(false));
  }, []);

  const handleConnect = async () => {
    if (!id || !session?.pc?.id) return;
    if (installed === false) {
      setProviderMessage('Moonlight nao encontrado. Configure o caminho em Configuracoes.');
      return;
    }
    if (connecting) {
      console.log('[STREAM][CLIENT] connect lock active');
      return;
    }
    setConnecting(true);
    try {
      const tokenResponse = await request<{ token: string; expiresAt: string }>('/stream/connect-token', {
        method: 'POST',
        body: JSON.stringify({ pcId: session.pc.id }),
      });
      console.log('[STREAM][CLIENT] token ok', { pcId: session.pc.id, expiresAt: tokenResponse.expiresAt });

      const resolveResponse = await request<{
        connectAddress: string;
        connectHint?: string | null;
        pcName: string;
      }>('/stream/resolve', {
        method: 'POST',
        body: JSON.stringify({ token: tokenResponse.token }),
      });
      console.log('[STREAM][CLIENT] resolve ok', { pcName: resolveResponse.pcName });
      setConnectHint(resolveResponse.connectHint ?? null);

      const launched = await launchMoonlight(resolveResponse.connectAddress);
      if (launched) {
        console.log('[STREAM][CLIENT] launch ok');
        setProviderMessage('Abrindo Moonlight para conectar...');
      } else {
        console.error('[STREAM][CLIENT] launch fail');
        setProviderMessage('Nao foi possivel abrir o Moonlight automaticamente.');
      }
    } catch (err) {
      console.error('[STREAM][CLIENT] token/resolve fail', err);
      setProviderMessage(err instanceof Error ? err.message : 'Nao foi possivel iniciar a conexao.');
    } finally {
      setConnecting(false);
    }
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
          <li>Selecione o host e inicie a conexao.</li>
          <li>Complete o pareamento se necessario.</li>
          <li>Inicie a conexao.</li>
        </ol>
        <button type="button" onClick={handleConnect}>
          Tentar conectar
        </button>
        {installed === false && (
          <p className={styles.muted}>Moonlight nao detectado. Instale antes de conectar.</p>
        )}
        {connectHint && <p className={styles.muted}>{connectHint}</p>}
        {providerMessage && <p className={styles.muted}>{providerMessage}</p>}
      </div>
    </div>
  );
}

