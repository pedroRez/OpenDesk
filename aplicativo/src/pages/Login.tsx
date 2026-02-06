import type { FormEvent } from 'react';
import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { GoogleLogin, type CredentialResponse } from '@react-oauth/google';

import { useAuth } from '../lib/auth';

import styles from './Login.module.css';

export default function Login() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { login, loginWithGoogle } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const googleEnabled = Boolean(import.meta.env.VITE_GOOGLE_CLIENT_ID);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setMessage('');
    try {
      const user = await login({ email, password });
      setMessage(`Bem-vindo, ${user.displayName ?? user.username}!`);
      const next = searchParams.get('next') ?? '/';
      navigate(next);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Erro ao entrar');
    } finally {
      setLoading(false);
    }
  };

  const handleGoogleSuccess = async (credentialResponse: CredentialResponse) => {
    const idToken = credentialResponse.credential;
    if (!idToken) {
      setMessage('Falha ao obter token do Google.');
      return;
    }
    setGoogleLoading(true);
    setMessage('');
    try {
      const user = await loginWithGoogle(idToken);
      setMessage(`Bem-vindo, ${user.displayName ?? user.username}!`);
      const next = searchParams.get('next') ?? '/';
      navigate(next);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Erro ao entrar com Google');
    } finally {
      setGoogleLoading(false);
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
        <button type="submit" disabled={loading}>
          {loading ? 'Entrando...' : 'Entrar'}
        </button>
        {googleEnabled && (
          <div className={styles.googleBlock}>
            <span className={styles.divider}>ou</span>
            <GoogleLogin
              onSuccess={handleGoogleSuccess}
              onError={() => setMessage('Erro ao entrar com Google')}
              useOneTap={false}
              theme="outline"
              size="large"
            />
            {googleLoading && <span className={styles.helper}>Validando Google...</span>}
          </div>
        )}
        {message && <p>{message}</p>}
      </form>
    </section>
  );
}
