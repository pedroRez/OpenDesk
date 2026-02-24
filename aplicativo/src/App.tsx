import { useEffect } from 'react';
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

const SCROLL_DEBUG_ENABLED =
  import.meta.env.DEV
  && ['1', 'true', 'on', 'yes'].includes(
    String(import.meta.env.VITE_DEBUG_SCROLL_EVENTS ?? '').trim().toLowerCase(),
  );

function describeEventTarget(target: EventTarget | null): string {
  if (!target) return 'null';
  if (target === window) return 'window';
  if (target === document) return 'document';
  if (target instanceof HTMLElement) {
    const id = target.id ? `#${target.id}` : '';
    const classes = typeof target.className === 'string'
      ? target.className.trim().split(/\s+/).filter(Boolean).slice(0, 3).join('.')
      : '';
    const classToken = classes ? `.${classes}` : '';
    return `${target.tagName.toLowerCase()}${id}${classToken}`;
  }
  return Object.prototype.toString.call(target);
}

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
  useEffect(() => {
    if (!SCROLL_DEBUG_ENABLED) return;

    const wheelListener = (event: WheelEvent) => {
      console.log('[SCROLL_DEBUG] wheel', {
        ts: Date.now(),
        target: describeEventTarget(event.target),
        currentTarget: describeEventTarget(event.currentTarget),
        deltaX: Number(event.deltaX.toFixed(2)),
        deltaY: Number(event.deltaY.toFixed(2)),
        deltaMode: event.deltaMode,
        defaultPrevented: event.defaultPrevented,
      });
    };

    const scrollListener = (event: Event) => {
      const target = event.target as EventTarget | null;
      const scrollTop =
        target instanceof Document
          ? target.scrollingElement?.scrollTop ?? null
          : target instanceof HTMLElement
            ? target.scrollTop
            : null;
      console.log('[SCROLL_DEBUG] scroll', {
        ts: Date.now(),
        target: describeEventTarget(target),
        currentTarget: describeEventTarget(event.currentTarget),
        scrollTop,
      });
    };

    const originalWindowScrollTo = window.scrollTo;
    const originalElementScrollIntoView = Element.prototype.scrollIntoView;
    const originalElementScrollTo = Element.prototype.scrollTo;

    window.scrollTo = ((...args: unknown[]) => {
      console.warn('[SCROLL_DEBUG] programmatic window.scrollTo', {
        ts: Date.now(),
        args,
        stack: new Error().stack ?? null,
      });
      return (originalWindowScrollTo as (...innerArgs: unknown[]) => void)(...args);
    }) as typeof window.scrollTo;

    Element.prototype.scrollIntoView = function scrollIntoViewPatched(
      ...args: Parameters<Element['scrollIntoView']>
    ): void {
      console.warn('[SCROLL_DEBUG] programmatic element.scrollIntoView', {
        ts: Date.now(),
        target: describeEventTarget(this),
        args,
        stack: new Error().stack ?? null,
      });
      return originalElementScrollIntoView.apply(this, args);
    };

    Element.prototype.scrollTo = function scrollToPatched(
      ...args: Parameters<Element['scrollTo']>
    ): void {
      console.warn('[SCROLL_DEBUG] programmatic element.scrollTo', {
        ts: Date.now(),
        target: describeEventTarget(this),
        args,
        stack: new Error().stack ?? null,
      });
      return originalElementScrollTo.apply(this, args);
    };

    window.addEventListener('wheel', wheelListener, { capture: true, passive: false });
    window.addEventListener('scroll', scrollListener, { capture: true, passive: true });
    console.info('[SCROLL_DEBUG] enabled');

    return () => {
      window.removeEventListener('wheel', wheelListener, { capture: true });
      window.removeEventListener('scroll', scrollListener, { capture: true });
      window.scrollTo = originalWindowScrollTo;
      Element.prototype.scrollIntoView = originalElementScrollIntoView;
      Element.prototype.scrollTo = originalElementScrollTo;
      console.info('[SCROLL_DEBUG] disabled');
    };
  }, []);

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
