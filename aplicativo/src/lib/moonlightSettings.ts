const MOONLIGHT_PATH_KEY = 'opendesk_moonlight_path';

export function getMoonlightPath(): string | null {
  if (typeof window === 'undefined') return null;
  const value = localStorage.getItem(MOONLIGHT_PATH_KEY);
  return value && value.trim() ? value : null;
}

export function setMoonlightPath(path: string | null): void {
  if (typeof window === 'undefined') return;
  if (!path || !path.trim()) {
    localStorage.removeItem(MOONLIGHT_PATH_KEY);
    return;
  }
  localStorage.setItem(MOONLIGHT_PATH_KEY, path.trim());
}
