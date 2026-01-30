'use client';

import { useState } from 'react';

import { apiBaseUrl } from '../../lib/api';
import { saveUser } from '../../lib/session';

import styles from './page.module.css';

export default function RegisterPage() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('CLIENT');
  const [message, setMessage] = useState('');

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    const response = await fetch(`${apiBaseUrl}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email, role }),
    });
    const data = await response.json();
    if (response.ok) {
      saveUser({
        id: data.user.id,
        name: data.user.name,
        email: data.user.email,
        role: data.user.role,
      });
      setMessage(`Conta criada! Bem-vindo, ${data.user.name}.`);
    } else {
      setMessage(data.error ?? 'Erro ao registrar');
    }
  };

  return (
    <div className={styles.container}>
      <h1>Criar conta</h1>
      <form onSubmit={handleSubmit} className={styles.form}>
        <label>
          Nome
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
          />
        </label>
        <label>
          Email
          <input
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />
        </label>
        <label>
          Perfil
          <select value={role} onChange={(event) => setRole(event.target.value)}>
            <option value="CLIENT">Cliente</option>
            <option value="HOST">Host</option>
          </select>
        </label>
        <button type="submit">Criar</button>
        {message && <p>{message}</p>}
      </form>
    </div>
  );
}
