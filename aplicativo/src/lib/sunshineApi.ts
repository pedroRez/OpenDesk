import { isTauriRuntime } from './hostDaemon';

type SunshineApiResult = {
  ok: boolean;
  skipped?: boolean;
  error?: string;
};

const toBool = (value: string | undefined) =>
  ['1', 'true', 'yes', 'on'].includes((value ?? '').toString().trim().toLowerCase());

const API_ENABLED = toBool(import.meta.env.VITE_SUNSHINE_API_ENABLED);
const API_BASE_URL = (import.meta.env.VITE_SUNSHINE_API_URL ?? '').toString().trim();
const API_USER = (import.meta.env.VITE_SUNSHINE_API_USER ?? '').toString();
const API_PASS = (import.meta.env.VITE_SUNSHINE_API_PASS ?? '').toString();

const isConfigured = () => API_ENABLED && API_BASE_URL && API_USER && API_PASS;

const buildBasicAuth = () => {
  const raw = `${API_USER}:${API_PASS}`;
  if (typeof btoa === 'function') {
    return btoa(raw);
  }
  return '';
};

const sunshineFetch = async (path: string, init?: RequestInit): Promise<Response> => {
  const auth = buildBasicAuth();
  const url = `${API_BASE_URL}${path}`;
  const headers = new Headers(init?.headers ?? {});
  if (auth) {
    headers.set('Authorization', `Basic ${auth}`);
  }
  return fetch(url, { ...init, headers });
};

export async function unpairAllSunshineClients(): Promise<SunshineApiResult> {
  if (!isTauriRuntime() || !isConfigured()) {
    return { ok: false, skipped: true };
  }

  try {
    const response = await sunshineFetch('/api/clients/unpair-all', { method: 'POST' });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      return { ok: false, error: `HTTP ${response.status} ${text}`.trim() };
    }
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'erro desconhecido';
    return { ok: false, error: message };
  }
}

