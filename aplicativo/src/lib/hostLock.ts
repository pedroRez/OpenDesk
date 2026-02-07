const HOST_LOCK_KEY = 'opendesk_host_lock_hash';

async function sha256(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  const bytes = Array.from(new Uint8Array(digest));
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function hasHostLockPin(): boolean {
  if (typeof window === 'undefined') return false;
  return Boolean(localStorage.getItem(HOST_LOCK_KEY));
}

export async function setHostLockPin(pin: string): Promise<void> {
  if (typeof window === 'undefined') return;
  const trimmed = pin.trim();
  if (!trimmed) return;
  const hashed = await sha256(trimmed);
  localStorage.setItem(HOST_LOCK_KEY, hashed);
}

export async function verifyHostLockPin(pin: string): Promise<boolean> {
  if (typeof window === 'undefined') return false;
  const stored = localStorage.getItem(HOST_LOCK_KEY);
  if (!stored) return false;
  const hashed = await sha256(pin.trim());
  return stored === hashed;
}

export function clearHostLockPin(): void {
  if (typeof window === 'undefined') return;
  localStorage.removeItem(HOST_LOCK_KEY);
}
