import type { FormEvent } from 'react';
import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';

import { useAuth } from '../lib/auth';

import styles from './Login.module.css';

export default function Login() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setMessage('');
    try {
      const user = await login({ email });
      setMessage(`Bem-vindo, ${user.name}!`);
      const next = searchParams.get('next') ?? '/';
      navigate(next);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Erro ao entrar');
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className={styles.container}>
      <h1>Entrar</h1>
      <form onSubmit={handleSubmit} className={styles.form}>
        <label>
          Email
          <input
            type="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </label>
        <button type="submit" disabled={loading}>
          {loading ? 'Entrando...' : 'Entrar'}
        </button>
        {message && <p>{message}</p>}
      </form>
    </section>
  );
}
