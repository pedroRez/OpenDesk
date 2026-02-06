import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { useAuth } from '../lib/auth';
import { request } from '../lib/api';

import styles from './SetupUsername.module.css';

export default function SetupUsername() {
  const navigate = useNavigate();
  const { user, setUsername } = useAuth();
  const [value, setValue] = useState(user?.username ?? '');
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(false);
  const [checking, setChecking] = useState(false);

  const handleCheck = async () => {
    const candidate = value.trim();
    if (!candidate) {
      setStatus('Informe um username.');
      return;
    }
    setChecking(true);
    setStatus('');
    try {
      const result = await request<{ available: boolean; username: string }>(
        `/auth/username-available?u=${encodeURIComponent(candidate)}`,
      );
      if (result.available) {
        setStatus(`Disponivel: ${result.username}`);
      } else {
        setStatus('Username indisponivel.');
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Erro ao verificar username.');
    } finally {
      setChecking(false);
    }
  };

  const handleSubmit = async () => {
    const candidate = value.trim();
    if (!candidate) {
      setStatus('Informe um username.');
      return;
    }
    setLoading(true);
    setStatus('');
    try {
      const updated = await setUsername(candidate);
      setStatus(`Username salvo: ${updated.username}`);
      navigate('/');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Erro ao salvar username.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className={styles.container}>
      <h1>Escolha seu username</h1>
      <p>Seu username publico aparecera no marketplace no lugar do email.</p>
      <div className={styles.form}>
        <label>
          Username
          <input
            value={value}
            onChange={(event) => {
              setValue(event.target.value);
              setStatus('');
            }}
            placeholder="ex: rapha_dev"
          />
        </label>
        <div className={styles.actions}>
          <button type="button" onClick={handleCheck} disabled={checking}>
            {checking ? 'Verificando...' : 'Verificar disponibilidade'}
          </button>
          <button type="button" onClick={handleSubmit} disabled={loading}>
            {loading ? 'Salvando...' : 'Salvar username'}
          </button>
        </div>
        {status && <p className={styles.helper}>{status}</p>}
      </div>
    </section>
  );
}
