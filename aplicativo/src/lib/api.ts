import { getStoredUserId } from './session';

export const apiBaseUrl = import.meta.env.VITE_API_URL ?? 'http://localhost:3333';

type ApiErrorPayload = {
  error?: string;
  message?: string;
  code?: string;
};

function buildHeaders(init?: RequestInit): Headers {
  const headers = new Headers(init?.headers ?? {});
  const userId = getStoredUserId();
  if (userId && !headers.has('x-user-id')) {
    headers.set('x-user-id', userId);
  }
  const hasBody = Boolean(init?.body);
  if (hasBody && !headers.has('Content-Type') && !(init?.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
  }
  return headers;
}

function resolveErrorMessage(payload: unknown, status: number): string {
  if (payload && typeof payload === 'object') {
    const { error, message } = payload as ApiErrorPayload;
    if (error) return error;
    if (message) return message;
  }
  if (typeof payload === 'string' && payload.trim()) {
    return payload;
  }
  if (status === 401 || status === 403) {
    return 'Sem permissao. Faca login novamente.';
  }
  if (status === 404) {
    return 'Nao encontrado.';
  }
  if (status === 409) {
    return 'Conflito de status. Atualize e tente novamente.';
  }
  if (status >= 500) {
    return 'Erro interno. Tente novamente.';
  }
  return 'Erro na requisicao. Tente novamente.';
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${apiBaseUrl}${path}`, {
      ...init,
      headers: buildHeaders(init),
    });
  } catch (error) {
    const fallback = 'Falha de conexao. Verifique sua rede e tente novamente.';
    const message =
      error instanceof Error && error.message && !error.message.toLowerCase().includes('failed to fetch')
        ? error.message
        : fallback;
    throw new Error(message);
  }

  if (response.status === 204) {
    return null as T;
  }

  const contentType = response.headers.get('content-type') ?? '';
  let payload: unknown = null;
  if (contentType.includes('application/json')) {
    payload = await response.json().catch(() => null);
  } else {
    payload = await response.text().catch(() => null);
  }

  if (!response.ok) {
    throw new Error(resolveErrorMessage(payload, response.status));
  }

  return payload as T;
}

export const fetchJson = request;
