import { NavLink, useNavigate } from 'react-router-dom';

import { useAuth } from '../lib/auth';
import { useMode } from '../lib/mode';

import styles from './Header.module.css';

export default function Header() {
  const { user, logout } = useAuth();
  const { mode, clearMode } = useMode();
  const navigate = useNavigate();
  const showQuickLinks = Boolean(user && mode);

  const handleLogout = () => {
    logout();
    navigate('/');
  };

  const handleModeReset = () => {
    clearMode();
    navigate('/');
  };

  return (
    <header className={styles.header}>
      <div className={styles.brand}>
        <div className={styles.logo}>OD</div>
        <div>
          <div className={styles.title}>OpenDesk Desktop</div>
          <div className={styles.subtitle}>Marketplace & Host Console</div>
        </div>
        {mode && (
          <div className={styles.modeGroup}>
            <span className={styles.modeBadge}>
              Modo: {mode === 'CLIENT' ? 'Cliente' : 'Host'}
            </span>
            <button type="button" onClick={handleModeReset} className={styles.modeSwitch}>
              Trocar modo
            </button>
          </div>
        )}
      </div>

      <nav className={styles.nav}>
        {showQuickLinks && mode === 'CLIENT' && (
          <>
            <NavLink
              to="/client/marketplace"
              className={({ isActive }) =>
                `${styles.link} ${isActive ? styles.linkActive : ''}`
              }
            >
              Marketplace
            </NavLink>
            <NavLink
              to="/client/reservations"
              className={({ isActive }) =>
                `${styles.link} ${isActive ? styles.linkActive : ''}`
              }
            >
              Agendamentos
            </NavLink>
          </>
        )}
        {showQuickLinks && mode === 'HOST' && (
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
              <span className={styles.userName}>Ola, {user.displayName ?? user.username}</span>
            </div>
            <button type="button" onClick={handleLogout} className={styles.ghostButton}>
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
