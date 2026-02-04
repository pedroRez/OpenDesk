const SUNSHINE_PATH_KEY = 'opendesk_sunshine_path';

export function getSunshinePath(): string | null {
  if (typeof window === 'undefined') return null;
  const value = localStorage.getItem(SUNSHINE_PATH_KEY);
  return value && value.trim() ? value : null;
}

export function setSunshinePath(path: string | null): void {
  if (typeof window === 'undefined') return;
  if (!path || !path.trim()) {
    localStorage.removeItem(SUNSHINE_PATH_KEY);
    return;
  }
  localStorage.setItem(SUNSHINE_PATH_KEY, path.trim());
}
