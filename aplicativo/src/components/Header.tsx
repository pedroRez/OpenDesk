import { useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';

import { useAuth } from '../lib/auth';
import { useMode } from '../lib/mode';
import Tooltip from './Tooltip';

import styles from './Header.module.css';

export default function Header() {
  const { user, logout } = useAuth();
  const { mode, clearMode, setMode } = useMode();
  const navigate = useNavigate();
  const showQuickLinks = Boolean(user && mode);
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);

  const handleLogout = () => {
    logout();
    navigate('/');
  };

  const handleModeReset = () => {
    clearMode();
    navigate('/');
  };

  const handleGoHost = () => {
    setMode('HOST');
    navigate('/host/dashboard');
    setProfileMenuOpen(false);
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
            <Tooltip label="Trocar modo">
              <button
                type="button"
                onClick={handleModeReset}
                className={styles.modeIconButton}
                aria-label="Trocar modo"
              >
                ⇆
              </button>
            </Tooltip>
          </div>
        )}
      </div>

      <nav className={styles.nav}>
        {showQuickLinks && mode === 'CLIENT' && (
          <>
            <NavLink
              to="/client/marketplace"
              className={({ isActive }) =>
                `${styles.link} ${styles.linkPrimary} ${isActive ? styles.linkActive : ''}`
              }
            >
              Marketplace
            </NavLink>
            <NavLink
              to="/client/reservations"
              className={({ isActive }) =>
                `${styles.link} ${styles.linkGhost} ${isActive ? styles.linkGhostActive : ''}`
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
            `${styles.link} ${mode === 'CLIENT' ? styles.linkGhost : ''} ${isActive ? styles.linkGhostActive : ''}`
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
            {mode === 'CLIENT' && (
              <div className={styles.profileMenu}>
                <Tooltip label="Menu do perfil">
                  <button
                    type="button"
                    className={styles.profileButton}
                    onClick={() => setProfileMenuOpen((prev) => !prev)}
                    aria-label="Abrir menu do perfil"
                    aria-expanded={profileMenuOpen}
                  >
                    ⋯
                  </button>
                </Tooltip>
                {profileMenuOpen && (
                  <div className={styles.profileDropdown}>
                    <button
                      type="button"
                      className={styles.profileItem}
                      onClick={handleGoHost}
                    >
                      Disponibilizar meu PC
                    </button>
                  </div>
                )}
              </div>
            )}
            <button type="button" onClick={handleLogout} className={styles.exitButton}>
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
