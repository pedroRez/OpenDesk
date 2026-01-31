import { createContext, useContext, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

export type AppMode = 'CLIENT' | 'HOST';

const MODE_KEY = 'opendesk_mode';

function loadMode(): AppMode | null {
  if (typeof window === 'undefined') return null;
  const raw = localStorage.getItem(MODE_KEY);
  if (raw === 'CLIENT' || raw === 'HOST') return raw;
  return null;
}

function saveMode(mode: AppMode | null): void {
  if (typeof window === 'undefined') return;
  if (!mode) {
    localStorage.removeItem(MODE_KEY);
    return;
  }
  localStorage.setItem(MODE_KEY, mode);
}

type ModeContextValue = {
  mode: AppMode | null;
  setMode: (mode: AppMode) => void;
  clearMode: () => void;
};

const ModeContext = createContext<ModeContextValue | undefined>(undefined);

export function ModeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<AppMode | null>(loadMode());

  const setMode = (nextMode: AppMode) => {
    saveMode(nextMode);
    setModeState(nextMode);
  };

  const clearMode = () => {
    saveMode(null);
    setModeState(null);
  };

  const value = useMemo<ModeContextValue>(
    () => ({ mode, setMode, clearMode }),
    [mode],
  );

  return <ModeContext.Provider value={value}>{children}</ModeContext.Provider>;
}

export function useMode() {
  const ctx = useContext(ModeContext);
  if (!ctx) {
    throw new Error('useMode must be used within ModeProvider');
  }
  return ctx;
}
