import type { FormEvent } from 'react';
import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';

import { useAuth } from '../lib/auth';

import styles from './Register.module.css';

export default function Register() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { register } = useAuth();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('CLIENT');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setMessage('');
    try {
      const user = await register({ name, email, role });
      setMessage(`Conta criada! Bem-vindo, ${user.name}.`);
      const next = searchParams.get('next') ?? '/';
      navigate(next);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Erro ao registrar');
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className={styles.container}>
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
        <button type="submit" disabled={loading}>
          {loading ? 'Criando...' : 'Criar'}
        </button>
        {message && <p>{message}</p>}
      </form>
    </section>
  );
}
