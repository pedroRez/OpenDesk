const PRIMARY_PC_KEY = 'opendesk_primary_pc';
const LOCAL_PC_KEY = 'opendesk_local_pc';
const LOCAL_MACHINE_KEY = 'opendesk_local_machine_id';
const HOST_CONNECTION_KEY = 'opendesk_host_connection';

export function setPrimaryPcId(pcId: string | null): void {
  if (typeof window === 'undefined') return;
  if (!pcId) {
    localStorage.removeItem(PRIMARY_PC_KEY);
    return;
  }
  localStorage.setItem(PRIMARY_PC_KEY, pcId);
}

export function getPrimaryPcId(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem(PRIMARY_PC_KEY);
}

export function setLocalPcId(pcId: string | null): void {
  if (typeof window === 'undefined') return;
  if (!pcId) {
    localStorage.removeItem(LOCAL_PC_KEY);
    return;
  }
  localStorage.setItem(LOCAL_PC_KEY, pcId);
}

export function getLocalPcId(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem(LOCAL_PC_KEY);
}

export function setLocalMachineId(id: string | null): void {
  if (typeof window === 'undefined') return;
  if (!id) {
    localStorage.removeItem(LOCAL_MACHINE_KEY);
    return;
  }
  localStorage.setItem(LOCAL_MACHINE_KEY, id);
}

export function getLocalMachineId(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem(LOCAL_MACHINE_KEY);
}

export function setHostConnection(host: string, port: number): void {
  if (typeof window === 'undefined') return;
  const payload = JSON.stringify({ host, port });
  localStorage.setItem(HOST_CONNECTION_KEY, payload);
}

export function getHostConnection(): { host: string; port: number } | null {
  if (typeof window === 'undefined') return null;
  const raw = localStorage.getItem(HOST_CONNECTION_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { host?: string; port?: number };
    if (!parsed?.host) return null;
    return { host: parsed.host, port: Number(parsed.port) || 47990 };
  } catch {
    return null;
  }
}
