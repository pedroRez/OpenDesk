import type { ReactNode } from 'react';
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom';

import styles from './App.module.css';
import Header from './components/Header';
import HostDaemonManager from './components/HostDaemonManager';
import RequireAuth from './components/RequireAuth';
import { AuthProvider } from './lib/auth';
import { ModeProvider, useMode } from './lib/mode';

import ModeSelect from './pages/ModeSelect';
import Login from './pages/Login';
import Register from './pages/Register';
import Docs from './pages/Docs';
import Settings from './pages/Settings';
import Marketplace from './pages/client/Marketplace';
import PCDetail from './pages/client/PCDetail';
import Reserve from './pages/client/Reserve';
import Session from './pages/client/Session';
import Connection from './pages/client/Connection';
import HostDashboard from './pages/host/HostDashboard';

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
  return (
    <Routes>
      <Route path="/" element={<HomeRedirect />} />
      <Route path="/settings" element={<Settings />} />
      <Route path="/login" element={<Login />} />
      <Route path="/register" element={<Register />} />
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
        <HostDaemonManager />
        <HashRouter>
          <div className={styles.app}>
            <Header />
            <main className={styles.main}>
              <AppRoutes />
            </main>
          </div>
        </HashRouter>
      </AuthProvider>
    </ModeProvider>
  );
}
