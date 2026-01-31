import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';

import { useAuth } from '../lib/auth';

import styles from './RequireAuth.module.css';

export default function RequireAuth({
  children,
  label,
}: {
  children: ReactNode;
  label?: string;
}) {
  const { isAuthenticated, isLoading } = useAuth();
  const navigate = useNavigate();

  if (isLoading) {
    return <div className={styles.loading}>Carregando...</div>;
  }

  if (!isAuthenticated) {
    return (
      <div className={styles.panel}>
        <strong>Login necessario</strong>
        <p>{label ?? 'Faca login para continuar este fluxo.'}</p>
        <button type="button" onClick={() => navigate('/login')}>
          Entrar
        </button>
      </div>
    );
  }

  return <>{children}</>;
}
