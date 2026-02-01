import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';

import { useAuth } from '../lib/auth';

import styles from './RequireAuth.module.css';

export default function RequireAuth({
  children,
}: {
  children: ReactNode;
}) {
  const { isAuthenticated, isLoading } = useAuth();
  const location = useLocation();

  const nextPath = `${location.pathname}${location.search}`;
  const loginPath = `/login?next=${encodeURIComponent(nextPath)}`;

  if (isLoading) {
    return <div className={styles.loading}>Carregando...</div>;
  }

  if (!isAuthenticated) {
    return <Navigate to={loginPath} replace />;
  }

  return <>{children}</>;
}
