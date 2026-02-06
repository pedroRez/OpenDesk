import type { FormEvent } from 'react';
import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';

import { useAuth } from '../lib/auth';

import styles from './Register.module.css';

export default function Register() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { register } = useAuth();
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [role, setRole] = useState('CLIENT');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setMessage('');
    try {
      const normalizedUsername = username.trim();
      if (!normalizedUsername || normalizedUsername.length < 3) {
        throw new Error('Informe um username valido (min. 3 caracteres).');
      }
      if (password !== confirmPassword) {
        throw new Error('As senhas nao conferem.');
      }
      const user = await register({
        email,
        password,
        username: normalizedUsername,
        displayName: displayName || undefined,
        role,
      });
      setMessage(`Conta criada! Bem-vindo, ${user.displayName ?? user.username}.`);
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
          Username publico
          <input
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            placeholder="ex: rapha_dev"
            minLength={3}
            required
          />
        </label>
        <label>
          Nome exibido (opcional)
          <input
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            placeholder="Ex.: Rafa"
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
          Senha
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            minLength={6}
            required
          />
        </label>
        <label>
          Confirmar senha
          <input
            type="password"
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
            minLength={6}
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
