import { useState } from 'react';

import { useMode, type AppMode } from '../lib/mode';
import { useAuth } from '../lib/auth';
import { apiBaseUrl } from '../lib/api';

import styles from './Settings.module.css';

export default function Settings() {
  const { mode, setMode } = useMode();
  const { user } = useAuth();
  const [message, setMessage] = useState('');

  const handleModeChange = (nextMode: AppMode) => {
    setMode(nextMode);
    setMessage(`Modo atualizado para ${nextMode === 'CLIENT' ? 'Cliente' : 'Host'}.`);
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
          >
            Cliente
          </button>
          <button
            type="button"
            onClick={() => handleModeChange('HOST')}
            className={mode === 'HOST' ? styles.active : ''}
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

      {message && <p className={styles.message}>{message}</p>}
    </section>
  );
}
