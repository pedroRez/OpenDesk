import type { ReactNode } from 'react';
import { HashRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';

import styles from './App.module.css';
import Header from './components/Header';
import HostDaemonManager from './components/HostDaemonManager';
import RequireAuth from './components/RequireAuth';
import { ToastProvider } from './components/Toast';
import { AuthProvider } from './lib/auth';
import { ModeProvider, useMode } from './lib/mode';
import { useAuth } from './lib/auth';

import ModeSelect from './pages/ModeSelect';
import Login from './pages/Login';
import Register from './pages/Register';
import Docs from './pages/Docs';
import Settings from './pages/Settings';
import Marketplace from './pages/client/Marketplace';
import PCDetail from './pages/client/PCDetail';
import Reserve from './pages/client/Reserve';
import Queue from './pages/client/Queue';
import Reservations from './pages/client/Reservations';
import Session from './pages/client/Session';
import Connection from './pages/client/Connection';
import HostDashboard from './pages/host/HostDashboard';
import SetupUsername from './pages/SetupUsername';

function HomeRedirect() {
  const { mode } = useMode();
  if (mode === 'HOST') {
    return <Navigate to="/host/dashboard" replace />;
  }
  if (mode === 'CLIENT') {
    return <Navigate to="/client/marketplace" replace />;
  }
  return <ModeSelect />;
}

function RequireMode({ mode, children }: { mode: 'CLIENT' | 'HOST'; children: ReactNode }) {
  const { mode: currentMode } = useMode();
  if (!currentMode) {
    return <Navigate to="/" replace state={{ requireMode: mode }} />;
  }
  if (currentMode !== mode) {
    return <Navigate to={currentMode === 'HOST' ? '/host/dashboard' : '/client/marketplace'} replace />;
  }
  return <>{children}</>;
}

function AppRoutes() {
  const location = useLocation();
  const { user } = useAuth();

  if (user?.needsUsername && location.pathname !== '/setup-username') {
    return <Navigate to="/setup-username" replace />;
  }

  return (
    <Routes>
      <Route path="/" element={<HomeRedirect />} />
      <Route path="/settings" element={<Settings />} />
      <Route path="/login" element={<Login />} />
      <Route path="/register" element={<Register />} />
      <Route
        path="/setup-username"
        element={
          <RequireAuth>
            <SetupUsername />
          </RequireAuth>
        }
      />
      <Route path="/docs" element={<Docs />} />
      <Route
        path="/client/marketplace"
        element={
          <RequireMode mode="CLIENT">
            <Marketplace />
          </RequireMode>
        }
      />
      <Route
        path="/client/pcs/:id"
        element={
          <RequireMode mode="CLIENT">
            <PCDetail />
          </RequireMode>
        }
      />
      <Route
        path="/client/reserve/:pcId"
        element={
          <RequireMode mode="CLIENT">
            <RequireAuth>
              <Reserve />
            </RequireAuth>
          </RequireMode>
        }
      />
      <Route
        path="/client/queue/:pcId"
        element={
          <RequireMode mode="CLIENT">
            <RequireAuth>
              <Queue />
            </RequireAuth>
          </RequireMode>
        }
      />
      <Route
        path="/client/reservations"
        element={
          <RequireMode mode="CLIENT">
            <RequireAuth>
              <Reservations />
            </RequireAuth>
          </RequireMode>
        }
      />
      <Route
        path="/client/session/:id"
        element={
          <RequireMode mode="CLIENT">
            <RequireAuth>
              <Session />
            </RequireAuth>
          </RequireMode>
        }
      />
      <Route
        path="/client/connection/:id"
        element={
          <RequireMode mode="CLIENT">
            <RequireAuth>
              <Connection />
            </RequireAuth>
          </RequireMode>
        }
      />
      <Route
        path="/host/dashboard"
        element={
          <RequireMode mode="HOST">
            <RequireAuth>
              <HostDashboard />
            </RequireAuth>
          </RequireMode>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <ModeProvider>
      <AuthProvider>
        <ToastProvider>
          <HostDaemonManager />
          <HashRouter>
            <div className={styles.app}>
              <Header />
              <main className={styles.main}>
                <AppRoutes />
              </main>
            </div>
          </HashRouter>
        </ToastProvider>
      </AuthProvider>
    </ModeProvider>
  );
}
