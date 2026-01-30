'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { useAuth } from '../../lib/auth';

import styles from './page.module.css';

export default function RegisterPage() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('CLIENT');
  const [message, setMessage] = useState('');
  const { register } = useAuth();

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setMessage('');
    try {
      const user = await register({ name, email, role });
      setMessage(`Conta criada! Bem-vindo, ${user.name}.`);
      router.push('/');
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Erro ao registrar';
      setMessage(message);
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
