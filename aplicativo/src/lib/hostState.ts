const PRIMARY_PC_KEY = 'opendesk_primary_pc';
const LOCAL_PC_KEY = 'opendesk_local_pc';

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
