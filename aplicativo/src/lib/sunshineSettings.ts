import { normalizeWindowsPath } from './pathUtils';

const SUNSHINE_PATH_KEY = 'opendesk_sunshine_path';

export function getSunshinePath(): string | null {
  if (typeof window === 'undefined') return null;
  const value = localStorage.getItem(SUNSHINE_PATH_KEY);
  const normalized = value ? normalizeWindowsPath(value) : '';
  return normalized ? normalized : null;
}

export function setSunshinePath(path: string | null): void {
  if (typeof window === 'undefined') return;
  const normalized = path ? normalizeWindowsPath(path) : '';
  if (!normalized) {
    localStorage.removeItem(SUNSHINE_PATH_KEY);
    return;
  }
  localStorage.setItem(SUNSHINE_PATH_KEY, normalized);
}
