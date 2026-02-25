const DEFAULT_STREAM_TOKEN_TTL_MS = 60 * 60 * 1000;
const MIN_STREAM_TOKEN_TTL_MS = 60_000;

function parsePositiveInt(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.trunc(parsed);
}

function resolveStreamTokenTtlMs(): number {
  const envValue =
    parsePositiveInt(process.env.STREAM_CONNECT_TOKEN_TTL_MS)
    ?? parsePositiveInt(process.env.STREAM_TOKEN_TTL_MS);
  if (!envValue || envValue < MIN_STREAM_TOKEN_TTL_MS) {
    return DEFAULT_STREAM_TOKEN_TTL_MS;
  }
  return envValue;
}

export const streamConnectTokenTtlMs = resolveStreamTokenTtlMs();
