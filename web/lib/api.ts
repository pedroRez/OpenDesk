export const apiBaseUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3333';

export async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
    cache: 'no-store',
  });

  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({}));
    throw new Error(errorBody.error ?? 'Erro na API');
  }

  return response.json() as Promise<T>;
}
