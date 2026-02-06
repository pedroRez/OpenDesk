'use client';

import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import { fetchJson } from './api';
import { clearUser, loadUser, saveUser, type StoredUser } from './session';

type AuthContextValue = {
  user: StoredUser | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  login: (params: { email: string; password: string }) => Promise<StoredUser>;
  register: (params: {
    email: string;
    password: string;
    username: string;
    displayName?: string;
    role?: string;
  }) => Promise<StoredUser>;
  logout: () => void;
  refreshFromStorage: () => void;
  updateUser: (patch: Partial<StoredUser>) => void;
};

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

function normalizeUser(data: any): StoredUser {
  const user = data?.user ?? data ?? {};
  const id = user.id ?? data?.userId ?? '';
  if (!id) {
    throw new Error('Resposta de autenticacao invalida');
  }
  const email = user.email ?? data?.email ?? '';
  const username =
    user.username ??
    user.name ??
    (email && email.includes('@') ? email.split('@')[0] : email) ??
    'usuario';
  return {
    id,
    username,
    displayName: user.displayName ?? user.name ?? data?.displayName ?? null,
    email,
    role: user.role ?? data?.role ?? 'CLIENT',
    hostProfileId: user.host?.id ?? user.hostProfileId ?? data?.hostProfileId ?? null,
  };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<StoredUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const refreshFromStorage = () => {
    const stored = loadUser();
    setUser(stored);
    setIsLoading(false);
  };

  useEffect(() => {
    refreshFromStorage();
  }, []);

  const login = async ({ email, password }: { email: string; password: string }) => {
    setIsLoading(true);
    try {
      const data = await fetchJson<any>('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      });
      const nextUser = normalizeUser(data);
      saveUser(nextUser);
      setUser(nextUser);
      return nextUser;
    } finally {
      setIsLoading(false);
    }
  };

  const register = async ({
    email,
    password,
    username,
    displayName,
    role,
  }: {
    email: string;
    password: string;
    username: string;
    displayName?: string;
    role?: string;
  }) => {
    setIsLoading(true);
    try {
      const data = await fetchJson<any>('/auth/register', {
        method: 'POST',
        body: JSON.stringify({ email, password, username, displayName, role }),
      });
      const nextUser = normalizeUser(data);
      saveUser(nextUser);
      setUser(nextUser);
      return nextUser;
    } finally {
      setIsLoading(false);
    }
  };

  const logout = () => {
    clearUser();
    setUser(null);
  };

  const updateUser = (patch: Partial<StoredUser>) => {
    setUser((current) => {
      if (!current) return current;
      const next = { ...current, ...patch };
      saveUser(next);
      return next;
    });
  };

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      isLoading,
      isAuthenticated: Boolean(user),
      login,
      register,
      logout,
      refreshFromStorage,
      updateUser,
    }),
    [user, isLoading],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return ctx;
}
