import type { FormEvent } from 'react';
import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { open } from '@tauri-apps/plugin-shell';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';

import { useAuth } from '../lib/auth';
import { request } from '../lib/api';
import { isTauriRuntime } from '../lib/hostDaemon';

import styles from './Login.module.css';

export default function Login() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { login, loginWithGoogleOAuth } = useAuth();
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

  const handleGoogleLogin = async () => {
    if (!isTauriRuntime()) {
      setMessage('Login com Google disponivel apenas no app desktop.');
      return;
    }
    setGoogleLoading(true);
    setMessage('');
    try {
      const start = await request<{
        url: string;
        state?: string;
        codeVerifier: string;
        redirectUri?: string;
      }>('/auth/google/start');

      let port = 43110;
      if (start.redirectUri) {
        try {
          const parsed = new URL(start.redirectUri);
          const parsedPort = Number(parsed.port);
          if (parsedPort) port = parsedPort;
        } catch {
          // ignore
        }
      }

      await invoke('start_oauth_listener', { port });

      const callbackPromise = new Promise<{ code?: string; state?: string; error?: string }>(
        (resolve, reject) => {
          let unlisten: (() => void) | null = null;
          const timeout = setTimeout(() => {
            if (unlisten) {
              unlisten();
            }
            reject(new Error('Tempo esgotado aguardando o Google.'));
          }, 5 * 60 * 1000);

          listen<{ code?: string; state?: string; error?: string }>('oauth-callback', (event) => {
            clearTimeout(timeout);
            if (unlisten) {
              unlisten();
            }
            resolve(event.payload);
          })
            .then((fn) => {
              unlisten = fn;
            })
            .catch((error) => {
              clearTimeout(timeout);
              reject(error);
            });
        },
      );

      await open(start.url);
      const payload = await callbackPromise;

      if (payload.error) {
        throw new Error(payload.error);
      }
      if (!payload.code) {
        throw new Error('Codigo OAuth nao recebido.');
      }

      const user = await loginWithGoogleOAuth({
        code: payload.code,
        codeVerifier: start.codeVerifier,
        state: payload.state ?? start.state,
      });

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
            <button type="button" onClick={handleGoogleLogin} disabled={googleLoading}>
              {googleLoading ? 'Abrindo Google...' : 'Entrar com Google'}
            </button>
            {googleLoading && <span className={styles.helper}>Aguardando o Google...</span>}
          </div>
        )}
        {message && <p>{message}</p>}
      </form>
    </section>
  );
}
