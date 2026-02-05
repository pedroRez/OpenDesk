import { normalizeWindowsPath } from './pathUtils';

const MOONLIGHT_PATH_KEY = 'opendesk_moonlight_path';

export function getMoonlightPath(): string | null {
  if (typeof window === 'undefined') return null;
  const value = localStorage.getItem(MOONLIGHT_PATH_KEY);
  const normalized = value ? normalizeWindowsPath(value) : '';
  return normalized ? normalized : null;
}

export function setMoonlightPath(path: string | null): void {
  if (typeof window === 'undefined') return;
  const normalized = path ? normalizeWindowsPath(path) : '';
  if (!normalized) {
    localStorage.removeItem(MOONLIGHT_PATH_KEY);
    return;
  }
  localStorage.setItem(MOONLIGHT_PATH_KEY, normalized);
}
