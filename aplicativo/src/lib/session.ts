export type StoredUser = {
  id: string;
  username: string;
  displayName?: string | null;
  email: string;
  role: string;
  hostProfileId?: string | null;
  token?: string | null;
  needsUsername?: boolean;
};

const STORAGE_KEY = 'opendesk_user';

export function saveUser(user: StoredUser): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(user));
}

export function loadUser(): StoredUser | null {
  if (typeof window === 'undefined') return null;
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredUser> & { name?: string };
    if (!parsed?.id || !parsed?.email) return null;
    const fallbackUsername = parsed.username ?? parsed.name ?? 'usuario';
    return {
      id: parsed.id,
      username: fallbackUsername ?? 'usuario',
      displayName: parsed.displayName ?? parsed.name ?? null,
      email: parsed.email,
      role: parsed.role ?? 'CLIENT',
      hostProfileId: parsed.hostProfileId ?? null,
      token: parsed.token ?? null,
      needsUsername: parsed.needsUsername ?? false,
    };
  } catch {
    return null;
  }
}

export function clearUser(): void {
  if (typeof window === 'undefined') return;
  localStorage.removeItem(STORAGE_KEY);
}

export function getStoredUserId(): string | null {
  return loadUser()?.id ?? null;
}

export function getStoredToken(): string | null {
  return loadUser()?.token ?? null;
}
