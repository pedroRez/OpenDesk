import type { ReactNode } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';

import { useAuth } from '../lib/auth';

import styles from './RequireAuth.module.css';

export default function RequireAuth({
  children,
  label,
  redirectToLogin = false,
}: {
  children: ReactNode;
  label?: string;
  redirectToLogin?: boolean;
}) {
  const { isAuthenticated, isLoading } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const nextPath = `${location.pathname}${location.search}`;
  const loginPath = `/login?next=${encodeURIComponent(nextPath)}`;

  if (isLoading) {
    return <div className={styles.loading}>Carregando...</div>;
  }

  if (!isAuthenticated) {
    if (redirectToLogin) {
      return <Navigate to={loginPath} replace />;
    }
    return (
      <div className={styles.panel}>
        <strong>Login necessario</strong>
        <p>{label ?? 'Faca login para continuar este fluxo.'}</p>
        <button type="button" onClick={() => navigate(loginPath)}>
          Entrar
        </button>
      </div>
    );
  }

  return <>{children}</>;
}
