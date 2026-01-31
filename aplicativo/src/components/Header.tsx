import { NavLink } from 'react-router-dom';

import { useAuth } from '../lib/auth';
import { useMode } from '../lib/mode';

import styles from './Header.module.css';

export default function Header() {
  const { user, logout } = useAuth();
  const { mode } = useMode();

  return (
    <header className={styles.header}>
      <div className={styles.brand}>
        <div className={styles.logo}>OD</div>
        <div>
          <div className={styles.title}>OpenDesk Desktop</div>
          <div className={styles.subtitle}>Marketplace & Host Console</div>
        </div>
        {mode && (
          <span className={styles.modeBadge}>
            Modo {mode === 'CLIENT' ? 'Cliente' : 'Host'}
          </span>
        )}
        {mode && (
          <NavLink to="/settings" className={styles.modeLink}>
            Trocar modo
          </NavLink>
        )}
      </div>

      <nav className={styles.nav}>
        {mode === 'CLIENT' && (
          <NavLink
            to="/client/marketplace"
            className={({ isActive }) =>
              `${styles.link} ${isActive ? styles.linkActive : ''}`
            }
          >
            Marketplace
          </NavLink>
        )}
        {mode === 'HOST' && (
          <NavLink
            to="/host/dashboard"
            className={({ isActive }) =>
              `${styles.link} ${isActive ? styles.linkActive : ''}`
            }
          >
            Painel do Host
          </NavLink>
        )}
        <NavLink
          to="/settings"
          className={({ isActive }) =>
            `${styles.link} ${isActive ? styles.linkActive : ''}`
          }
        >
          Configuracoes
        </NavLink>
      </nav>

      <div className={styles.user}>
        {user ? (
          <>
            <div className={styles.userMeta}>
              <span className={styles.userName}>Ola, {user.name}</span>
              <span className={styles.userEmail}>{user.email}</span>
            </div>
            <button type="button" onClick={logout} className={styles.ghostButton}>
              Sair
            </button>
          </>
        ) : (
          <>
            <NavLink to="/login" className={styles.ghostButton}>
              Entrar
            </NavLink>
            <NavLink to="/register" className={styles.primaryButton}>
              Criar conta
            </NavLink>
          </>
        )}
      </div>
    </header>
  );
}
