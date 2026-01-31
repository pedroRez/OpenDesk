const PRIMARY_PC_KEY = 'opendesk_primary_pc';

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
