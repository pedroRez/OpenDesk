'use client';

import { useState } from 'react';

import { apiBaseUrl } from '../../lib/api';

import styles from './page.module.css';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState('');

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    const response = await fetch(`${apiBaseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    const data = await response.json();
    if (response.ok) {
      setMessage(`Bem-vindo, ${data.user.name}! (token mock: ${data.token})`);
    } else {
      setMessage(data.error ?? 'Erro ao entrar');
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
        <button type="submit">Entrar</button>
        {message && <p>{message}</p>}
      </form>
    </div>
  );
}
