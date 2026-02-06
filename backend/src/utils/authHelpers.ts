import bcrypt from 'bcryptjs';
import { OAuth2Client } from 'google-auth-library';
import type { PrismaClient } from '@prisma/client';

const USERNAME_MAX_LENGTH = 20;

export function normalizeUsername(input: string): string {
  const base = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '');
  if (!base) return 'user';
  return base.slice(0, USERNAME_MAX_LENGTH);
}

export async function ensureUniqueUsername(
  prisma: PrismaClient,
  desired: string,
): Promise<string> {
  const base = normalizeUsername(desired);
  const existing = await prisma.user.findUnique({ where: { username: base } });
  if (!existing) return base;

  for (let i = 0; i < 8; i += 1) {
    const suffix = Math.random().toString(36).slice(2, 6);
    const candidate = `${base}-${suffix}`.slice(0, USERNAME_MAX_LENGTH);
    const found = await prisma.user.findUnique({ where: { username: candidate } });
    if (!found) return candidate;
  }

  const fallback = `${base}-${Date.now().toString(36)}`.slice(0, USERNAME_MAX_LENGTH);
  return fallback;
}

export function usernameFromEmail(email: string): string {
  const local = email.split('@')[0] ?? email;
  return normalizeUsername(local);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = await bcrypt.genSalt(10);
  return bcrypt.hash(password, salt);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export async function verifyGoogleToken(idToken: string, clientId: string) {
  const client = new OAuth2Client(clientId);
  const ticket = await client.verifyIdToken({
    idToken,
    audience: clientId,
  });
  return ticket.getPayload();
}
