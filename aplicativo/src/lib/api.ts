import { getStoredUserId } from './session';

export const apiBaseUrl = import.meta.env.VITE_API_URL ?? 'http://localhost:3333';

function buildHeaders(init?: RequestInit): HeadersInit {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  const userId = getStoredUserId();
  if (userId) {
    headers['x-user-id'] = userId;
  }
  const extra = init?.headers ?? {};
  if (Array.isArray(extra)) {
    for (const [key, value] of extra) {
      headers[key] = value;
    }
  } else if (extra instanceof Headers) {
    extra.forEach((value, key) => {
      headers[key] = value;
    });
  } else {
    Object.assign(headers, extra);
  }
  return headers;
}

export async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...init,
    headers: buildHeaders(init),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error((data as { error?: string }).error ?? 'Erro na API');
  }

  return data as T;
}
