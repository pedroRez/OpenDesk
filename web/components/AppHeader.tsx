'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';

import { useAuth } from '../lib/auth';

import styles from './AppHeader.module.css';

export default function AppHeader() {
  const router = useRouter();
  const { user, isAuthenticated, isLoading, logout } = useAuth();

  const handleLogout = () => {
    logout();
    router.push('/');
  };

  return (
    <header className={styles.header}>
      <Link href="/" className={styles.logo}>
        OpenDesk
      </Link>

      <nav className={styles.nav}>
        <Link href="/">Marketplace</Link>
        <Link href="/host/dashboard">Painel do Host</Link>
        <Link href="/docs">Ajuda</Link>
      </nav>

      <div className={styles.auth}>
        {isLoading ? (
          <span className={styles.loading}>Carregando...</span>
        ) : isAuthenticated && user ? (
          <>
            <span>
              Ola, {user.name || user.email}
            </span>
            <button type="button" onClick={handleLogout} className={styles.logout}>
              Sair
            </button>
          </>
        ) : (
          <span>
            <Link href="/login">Entrar</Link> / <Link href="/register">Criar conta</Link>
          </span>
        )}
      </div>
    </header>
  );
}
