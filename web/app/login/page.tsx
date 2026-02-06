'use client';

import { useSearchParams, useRouter } from 'next/navigation';
import { useState } from 'react';

import { useAuth } from '../../lib/auth';

import styles from './page.module.css';

export default function LoginPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState('');
  const { login } = useAuth();

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setMessage('');
    try {
      const user = await login({ email, password });
      setMessage(`Bem-vindo, ${user.displayName ?? user.username}!`);
      const next = searchParams.get('next') ?? '/';
      router.push(next);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Erro ao entrar';
      setMessage(message);
    }
  };

  return (
    <div className={styles.container}>
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
        <label>
          Senha
          <input
            type="password"
            required
            minLength={6}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        <button type="submit">Entrar</button>
        {message && <p>{message}</p>}
      </form>
    </div>
  );
}
