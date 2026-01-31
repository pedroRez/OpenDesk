export type StoredUser = {
  id: string;
  name: string;
  email: string;
  role: string;
  hostProfileId?: string | null;
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
    const parsed = JSON.parse(raw) as Partial<StoredUser>;
    if (!parsed?.id || !parsed?.email) return null;
    return {
      id: parsed.id,
      name: parsed.name ?? parsed.email,
      email: parsed.email,
      role: parsed.role ?? 'CLIENT',
      hostProfileId: parsed.hostProfileId ?? null,
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
