import type { FormEvent } from 'react';
import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';

import { useAuth } from '../lib/auth';
import { request } from '../lib/api';

import styles from './Login.module.css';

export default function Login() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [showReset, setShowReset] = useState(false);
  const [resetEmail, setResetEmail] = useState('');
  const [resetToken, setResetToken] = useState('');
  const [resetPassword, setResetPassword] = useState('');
  const [resetStatus, setResetStatus] = useState('');
  const [resetLoading, setResetLoading] = useState(false);

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

  const handleRequestReset = async () => {
    const target = resetEmail.trim() || email.trim();
    if (!target) {
      setResetStatus('Informe um email.');
      return;
    }
    setResetLoading(true);
    setResetStatus('');
    try {
      const response = await request<{ ok: boolean; token?: string; expiresAt?: string }>(
        '/auth/forgot-password',
        {
          method: 'POST',
          body: JSON.stringify({ email: target }),
        },
      );
      if (response?.token) {
        setResetToken(response.token);
        setResetStatus('Token gerado em DEV. Cole abaixo para redefinir a senha.');
      } else {
        setResetStatus('Se o email existir, um token foi gerado.');
      }
    } catch (error) {
      setResetStatus(error instanceof Error ? error.message : 'Falha ao gerar token.');
    } finally {
      setResetLoading(false);
    }
  };

  const handleResetPassword = async () => {
    if (!resetToken || !resetPassword) {
      setResetStatus('Informe o token e a nova senha.');
      return;
    }
    setResetLoading(true);
    setResetStatus('');
    try {
      await request('/auth/reset-password', {
        method: 'POST',
        body: JSON.stringify({ token: resetToken, newPassword: resetPassword }),
      });
      setResetStatus('Senha atualizada. Voce pode fazer login.');
      setShowReset(false);
      setResetPassword('');
      setResetToken('');
    } catch (error) {
      setResetStatus(error instanceof Error ? error.message : 'Falha ao redefinir senha.');
    } finally {
      setResetLoading(false);
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
        <div className={styles.linksRow}>
          <Link to="/register">Criar conta</Link>
          <button type="button" className={styles.linkButton} onClick={() => setShowReset(true)}>
            Esqueci minha senha
          </button>
        </div>
        {message && <p>{message}</p>}
      </form>

      {showReset && (
        <div className={styles.resetOverlay} role="dialog" aria-modal="true">
          <div className={styles.resetPanel}>
            <div className={styles.resetHeader}>
              <strong>Reset de senha (DEV)</strong>
              <button type="button" className={styles.linkButton} onClick={() => setShowReset(false)}>
                Fechar
              </button>
            </div>
            <label>
              Email
              <input
                type="email"
                value={resetEmail}
                onChange={(event) => setResetEmail(event.target.value)}
              />
            </label>
            <button type="button" onClick={handleRequestReset} disabled={resetLoading}>
              {resetLoading ? 'Gerando...' : 'Gerar token'}
            </button>
            <label>
              Token
              <input
                value={resetToken}
                onChange={(event) => setResetToken(event.target.value)}
              />
            </label>
            <label>
              Nova senha
              <input
                type="password"
                value={resetPassword}
                onChange={(event) => setResetPassword(event.target.value)}
                minLength={6}
              />
            </label>
            <button type="button" onClick={handleResetPassword} disabled={resetLoading}>
              {resetLoading ? 'Salvando...' : 'Redefinir senha'}
            </button>
            {resetStatus && <p className={styles.helper}>{resetStatus}</p>}
          </div>
        </div>
      )}
    </section>
  );
}
