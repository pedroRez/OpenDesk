import { createHash } from 'crypto';

export function deriveStreamId(token: string): string {
  const hex = createHash('sha256').update(`stream:${token}`).digest('hex').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function normalizeStreamId(input: string): string {
  return input.trim().toLowerCase().replace(/-/g, '');
}

export function streamIdsEqual(a: string, b: string): boolean {
  return normalizeStreamId(a) === normalizeStreamId(b);
}
