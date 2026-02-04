import { useState } from 'react';

import { useToast } from '../components/Toast';
import { useMode, type AppMode } from '../lib/mode';
import { useAuth } from '../lib/auth';
import { apiBaseUrl } from '../lib/api';
import { markLocalPcOffline } from '../lib/localPc';
import { getSunshinePath, setSunshinePath } from '../lib/sunshineSettings';
import { getMoonlightPath, setMoonlightPath } from '../lib/moonlightSettings';

import styles from './Settings.module.css';

export default function Settings() {
  const { mode, setMode } = useMode();
  const { user } = useAuth();
  const [message, setMessage] = useState('');
  const toast = useToast();
  const [isSwitching, setIsSwitching] = useState(false);
  const [sunshinePath, setSunshinePathValue] = useState(() => getSunshinePath() ?? '');
  const [moonlightPath, setMoonlightPathValue] = useState(() => getMoonlightPath() ?? '');

  const handleModeChange = async (nextMode: AppMode) => {
    if (isSwitching) return;
    setIsSwitching(true);
    if (nextMode === 'CLIENT') {
      try {
        const changed = await markLocalPcOffline();
        if (changed) {
          toast.show('Este PC foi colocado OFFLINE porque o modo CLIENTE esta ativo nesta maquina.', 'info');
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Falha ao atualizar o PC local.';
        toast.show(errorMessage, 'error');
      }
    }
    setMode(nextMode);
    setMessage(`Modo atualizado para ${nextMode === 'CLIENT' ? 'Cliente' : 'Host'}.`);
    setIsSwitching(false);
  };

  return (
    <section className={styles.container}>
      <h1>Configuracoes</h1>

      <div className={styles.card}>
        <h3>Modo de uso</h3>
        <p>Escolha como este app deve iniciar por padrao.</p>
        <div className={styles.modeButtons}>
          <button
            type="button"
            onClick={() => handleModeChange('CLIENT')}
            className={mode === 'CLIENT' ? styles.active : ''}
            disabled={isSwitching}
          >
            Cliente
          </button>
          <button
            type="button"
            onClick={() => handleModeChange('HOST')}
            className={mode === 'HOST' ? styles.active : ''}
            disabled={isSwitching}
          >
            Host
          </button>
        </div>
      </div>

      <div className={styles.card}>
        <h3>Conta</h3>
        {user ? (
          <p>
            Logado como <strong>{user.name}</strong> ({user.email})
          </p>
        ) : (
          <p>Nenhum usuario logado.</p>
        )}
      </div>

      <div className={styles.card}>
        <h3>API</h3>
        <p>Endpoint atual: {apiBaseUrl}</p>
      </div>

      <div className={styles.card}>
        <h3>Streaming (Sunshine)</h3>
        <p>Defina o caminho do executavel para iniciar o Sunshine automaticamente no modo Host.</p>
        <label className={styles.field}>
          Caminho do Sunshine
          <input
            value={sunshinePath}
            onChange={(event) => setSunshinePathValue(event.target.value)}
            onBlur={() => setSunshinePath(sunshinePath)}
            placeholder="C:\\Program Files\\Sunshine\\sunshine.exe"
          />
        </label>
        <p className={styles.helper}>Se vazio, tentamos caminhos padrao do Windows.</p>
      </div>

      <div className={styles.card}>
        <h3>Streaming (Moonlight)</h3>
        <p>Defina o caminho do executavel para abrir o Moonlight automaticamente no modo Cliente.</p>
        <label className={styles.field}>
          Caminho do Moonlight
          <input
            value={moonlightPath}
            onChange={(event) => setMoonlightPathValue(event.target.value)}
            onBlur={() => setMoonlightPath(moonlightPath)}
            placeholder="C:\\Program Files\\Moonlight Game Streaming\\Moonlight.exe"
          />
        </label>
        <p className={styles.helper}>Se vazio, tentamos caminhos padrao do Windows.</p>
      </div>

      {message && <p className={styles.message}>{message}</p>}
    </section>
  );
}
