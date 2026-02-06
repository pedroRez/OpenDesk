import { z } from 'zod';
import crypto from 'node:crypto';

import type { FastifyInstance } from 'fastify';

import { hashPassword, normalizeUsername, verifyGoogleToken, verifyPassword } from '../utils/authHelpers.js';
import { signAccessToken } from '../utils/jwt.js';
import { requireUser } from '../utils/auth.js';

function sanitizeUser<T extends { passwordHash?: string | null; googleSub?: string | null }>(user: T) {
  const { passwordHash, googleSub, ...safe } = user;
  return safe;
}

function buildAuthResponse(user: any) {
  return {
    token: signAccessToken({ sub: user.id, role: user.role }),
    user: sanitizeUser(user),
    userId: user.id,
    role: user.role,
    hostProfileId: user.host?.id ?? null,
    needsUsername: !user.username,
  };
}

const LOGIN_WINDOW_MS = 5 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 5;
const loginAttempts = new Map<string, { count: number; resetAt: number }>();

function isRateLimited(key: string) {
  const now = Date.now();
  const entry = loginAttempts.get(key);
  if (!entry) return false;
  if (now > entry.resetAt) {
    loginAttempts.delete(key);
    return false;
  }
  return entry.count >= LOGIN_MAX_ATTEMPTS;
}

function recordLoginFailure(key: string) {
  const now = Date.now();
  const entry = loginAttempts.get(key);
  if (!entry || now > entry.resetAt) {
    loginAttempts.set(key, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
    return;
  }
  entry.count += 1;
}

function clearLoginFailures(key: string) {
  loginAttempts.delete(key);
}

function sha256(input: string) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function generateToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function generateCodeVerifier() {
  return crypto.randomBytes(32).toString('base64url');
}

function generateCodeChallenge(verifier: string) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

export async function authRoutes(fastify: FastifyInstance) {
  fastify.post('/auth/register', async (request, reply) => {
    const schema = z.object({
      email: z.string().email(),
      password: z.string().min(6).optional(),
      username: z.string().min(3).max(20).optional(),
      displayName: z.string().max(40).optional(),
      name: z.string().max(60).optional(),
      role: z.enum(['CLIENT', 'HOST', 'ADMIN']).default('CLIENT'),
    });

    const body = schema.parse(request.body);

    const existingEmail = await fastify.prisma.user.findUnique({ where: { email: body.email } });
    if (existingEmail) {
      fastify.log.warn({ email: body.email }, 'Auth register failed: email exists');
      return reply.status(409).send({ error: 'Email ja cadastrado' });
    }

    let normalizedUsername: string | null = null;
    if (body.username) {
      normalizedUsername = normalizeUsername(body.username);
      if (normalizedUsername.length < 3) {
        fastify.log.warn({ username: body.username }, 'Auth register failed: username invalid');
        return reply.status(400).send({ error: 'Username invalido' });
      }
      const existingUsername = await fastify.prisma.user.findUnique({
        where: { username: normalizedUsername },
      });
      if (existingUsername) {
        fastify.log.warn({ username: normalizedUsername }, 'Auth register failed: username exists');
        return reply.status(409).send({ error: 'Username ja em uso' });
      }
    }

    const isLegacy = !body.password;
    const allowLegacy = process.env.ALLOW_LEGACY_AUTH === 'true' || process.env.NODE_ENV !== 'production';
    if (isLegacy && !allowLegacy) {
      fastify.log.warn({ email: body.email }, 'Auth register failed: legacy blocked');
      return reply.status(400).send({ error: 'Defina uma senha para continuar' });
    }

    if (body.role === 'HOST' && !normalizedUsername) {
      fastify.log.warn({ email: body.email }, 'Auth register failed: host without username');
      return reply.status(400).send({ error: 'Defina um username antes de virar host' });
    }

    const resolvedDisplayName = body.displayName ?? body.name ?? null;
    const passwordHash = body.password ? await hashPassword(body.password) : null;
    const user = await fastify.prisma.user.create({
      data: {
        email: body.email,
        username: normalizedUsername,
        displayName: resolvedDisplayName,
        passwordHash,
        authProvider: 'PASSWORD',
        role: body.role,
        wallet: { create: { balance: 0 } },
        host:
          body.role === 'HOST' && normalizedUsername
            ? { create: { displayName: normalizedUsername } }
            : undefined,
      },
      include: { host: true },
    });

    fastify.log.info({ userId: user.id, email: user.email, provider: user.authProvider }, 'Auth register ok');
    return reply.send(buildAuthResponse(user));
  });

  fastify.post('/auth/login', async (request, reply) => {
    const schema = z.object({
      email: z.string().email(),
      password: z.string().min(6).optional(),
    });

    const body = schema.parse(request.body);
    const rateKey = `${request.ip}:${body.email.toLowerCase()}`;
    if (isRateLimited(rateKey)) {
      fastify.log.warn({ email: body.email }, 'Auth login rate limited');
      return reply.status(429).send({ error: 'Muitas tentativas. Tente novamente mais tarde.' });
    }
    const user = await fastify.prisma.user.findUnique({
      where: { email: body.email },
      include: { wallet: true, host: true },
    });

    if (!user) {
      recordLoginFailure(rateKey);
      fastify.log.warn({ email: body.email }, 'Auth login failed');
      return reply.status(401).send({ error: 'Credenciais invalidas' });
    }

    if (!body.password) {
      const allowLegacy = process.env.ALLOW_LEGACY_AUTH === 'true' || process.env.NODE_ENV !== 'production';
      if (!allowLegacy || user.passwordHash) {
        recordLoginFailure(rateKey);
        fastify.log.warn({ userId: user.id, email: body.email }, 'Auth login failed');
        return reply.status(401).send({ error: 'Credenciais invalidas' });
      }
      clearLoginFailures(rateKey);
      fastify.log.info({ userId: user.id, email: user.email, legacy: true }, 'Auth login ok');
      return reply.send(buildAuthResponse(user));
    }

    if (!user.passwordHash) {
      recordLoginFailure(rateKey);
      fastify.log.warn({ userId: user.id, email: body.email }, 'Auth login failed');
      return reply.status(401).send({ error: 'Credenciais invalidas' });
    }

    const ok = await verifyPassword(body.password, user.passwordHash);
    if (!ok) {
      recordLoginFailure(rateKey);
      fastify.log.warn({ userId: user.id, email: body.email }, 'Auth login failed');
      return reply.status(401).send({ error: 'Credenciais invalidas' });
    }

    clearLoginFailures(rateKey);
    fastify.log.info({ userId: user.id, email: user.email }, 'Auth login ok');
    return reply.send(buildAuthResponse(user));
  });

  fastify.post('/auth/forgot-password', async (request, reply) => {
    const schema = z.object({ email: z.string().email() });
    const body = schema.parse(request.body);
    const user = await fastify.prisma.user.findUnique({ where: { email: body.email } });

    if (!user) {
      return reply.send({ ok: true });
    }

    const token = generateToken();
    const tokenHash = sha256(token);
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

    await fastify.prisma.passwordResetToken.deleteMany({ where: { userId: user.id } });
    await fastify.prisma.passwordResetToken.create({
      data: { tokenHash, userId: user.id, expiresAt },
    });

    if (process.env.NODE_ENV !== 'production') {
      fastify.log.info({ email: user.email, token }, 'Password reset token (dev)');
      return reply.send({ ok: true, token, expiresAt: expiresAt.toISOString() });
    }

    return reply.send({ ok: true });
  });

  fastify.post('/auth/reset-password', async (request, reply) => {
    const schema = z.object({
      token: z.string().min(10),
      password: z.string().min(6),
    });
    const body = schema.parse(request.body);
    const tokenHash = sha256(body.token);
    const record = await fastify.prisma.passwordResetToken.findUnique({
      where: { tokenHash },
    });

    if (!record || record.usedAt || record.expiresAt.getTime() < Date.now()) {
      return reply.status(400).send({ error: 'Token invalido ou expirado' });
    }

    const passwordHash = await hashPassword(body.password);
    await fastify.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: record.userId },
        data: {
          passwordHash,
          authProvider: 'PASSWORD',
        },
      });
      await tx.passwordResetToken.update({
        where: { tokenHash },
        data: { usedAt: new Date() },
      });
    });

    return reply.send({ ok: true });
  });

  fastify.get('/auth/google/start', async (_request, reply) => {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const redirectUri = process.env.GOOGLE_REDIRECT_URI;
    if (!clientId || !redirectUri) {
      return reply.status(500).send({ error: 'Google OAuth nao configurado' });
    }

    const codeVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(codeVerifier);
    const state = crypto.randomBytes(16).toString('hex');
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    await fastify.prisma.oAuthState.create({
      data: {
        state,
        provider: 'GOOGLE',
        codeVerifier,
        expiresAt,
      },
    });

    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'openid email profile');
    url.searchParams.set('code_challenge', codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('state', state);
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('prompt', 'consent');

    return reply.send({
      url: url.toString(),
      state,
      codeVerifier,
      redirectUri,
      expiresAt: expiresAt.toISOString(),
    });
  });

  fastify.post('/auth/google/finish', async (request, reply) => {
    const schema = z.object({
      code: z.string().min(1),
      codeVerifier: z.string().min(10),
      state: z.string().optional(),
    });
    const body = schema.parse(request.body);
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    const redirectUri = process.env.GOOGLE_REDIRECT_URI;
    if (!clientId || !clientSecret || !redirectUri) {
      return reply.status(500).send({ error: 'Google OAuth nao configurado' });
    }

    if (body.state) {
      const stateRecord = await fastify.prisma.oAuthState.findUnique({
        where: { state: body.state },
      });
      if (!stateRecord || stateRecord.expiresAt.getTime() < Date.now()) {
        return reply.status(400).send({ error: 'State invalido ou expirado' });
      }
      if (stateRecord.codeVerifier !== body.codeVerifier) {
        return reply.status(400).send({ error: 'Code verifier invalido' });
      }
      await fastify.prisma.oAuthState.delete({ where: { state: body.state } });
    }

    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: body.code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
        code_verifier: body.codeVerifier,
      }),
    });

    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text().catch(() => '');
      fastify.log.warn({ status: tokenResponse.status, errorText }, 'Google OAuth token error');
      return reply.status(401).send({ error: 'OAuth Google falhou' });
    }

    const tokenPayload = (await tokenResponse.json()) as { id_token?: string };
    if (!tokenPayload.id_token) {
      return reply.status(401).send({ error: 'Token Google invalido' });
    }

    const payload = await verifyGoogleToken(tokenPayload.id_token, clientId);
    if (!payload?.sub || !payload.email) {
      return reply.status(401).send({ error: 'Token Google invalido' });
    }
    if (payload.email_verified === false) {
      return reply.status(401).send({ error: 'Email Google nao verificado' });
    }

    const existingBySub = await fastify.prisma.user.findFirst({
      where: { googleSub: payload.sub },
      include: { host: true },
    });
    if (existingBySub) {
      fastify.log.info({ userId: existingBySub.id, provider: 'GOOGLE' }, 'Auth login ok');
      return reply.send(buildAuthResponse(existingBySub));
    }

    const existingByEmail = await fastify.prisma.user.findUnique({
      where: { email: payload.email },
      include: { host: true },
    });
    if (existingByEmail) {
      if (existingByEmail.googleSub && existingByEmail.googleSub !== payload.sub) {
        fastify.log.warn({ email: payload.email }, 'Google OAuth conflict: different sub');
        return reply.status(409).send({ error: 'Conta Google diferente ja vinculada' });
      }
      const updated = await fastify.prisma.user.update({
        where: { id: existingByEmail.id },
        data: {
          googleSub: existingByEmail.googleSub ?? payload.sub,
          displayName: existingByEmail.displayName ?? payload.name ?? null,
        },
        include: { host: true },
      });
      fastify.log.info({ userId: updated.id, provider: 'GOOGLE', linked: true }, 'Auth login ok');
      return reply.send(buildAuthResponse(updated));
    }

    const user = await fastify.prisma.user.create({
      data: {
        email: payload.email,
        username: null,
        displayName: payload.name ?? null,
        authProvider: 'GOOGLE',
        googleSub: payload.sub,
        role: 'CLIENT',
        wallet: { create: { balance: 0 } },
      },
      include: { host: true },
    });

    fastify.log.info({ userId: user.id, provider: 'GOOGLE', created: true }, 'Auth register ok');
    return reply.send(buildAuthResponse(user));
  });

  // Legacy endpoint for desktop auth (idToken direct)
  fastify.post('/auth/google', async (request, reply) => {
    const schema = z.object({ idToken: z.string().min(10) });
    const body = schema.parse(request.body);

    const clientId = process.env.GOOGLE_CLIENT_ID;
    if (!clientId) {
      return reply.status(500).send({ error: 'Google Client ID nao configurado' });
    }

    const payload = await verifyGoogleToken(body.idToken, clientId);
    if (!payload?.sub || !payload.email) {
      return reply.status(401).send({ error: 'Token Google invalido' });
    }

    const existingBySub = await fastify.prisma.user.findFirst({
      where: { googleSub: payload.sub },
      include: { host: true },
    });
    if (existingBySub) {
      fastify.log.info({ userId: existingBySub.id, provider: 'GOOGLE' }, 'Auth login ok');
      return reply.send(buildAuthResponse(existingBySub));
    }

    const existingByEmail = await fastify.prisma.user.findUnique({
      where: { email: payload.email },
      include: { host: true },
    });
    if (existingByEmail) {
      if (existingByEmail.googleSub && existingByEmail.googleSub !== payload.sub) {
        fastify.log.warn({ email: payload.email }, 'Google token conflict: different sub');
        return reply.status(409).send({ error: 'Conta Google diferente ja vinculada' });
      }
      const updated = await fastify.prisma.user.update({
        where: { id: existingByEmail.id },
        data: {
          googleSub: existingByEmail.googleSub ?? payload.sub,
          displayName: existingByEmail.displayName ?? payload.name ?? null,
        },
        include: { host: true },
      });
      fastify.log.info({ userId: updated.id, provider: 'GOOGLE', linked: true }, 'Auth login ok');
      return reply.send(buildAuthResponse(updated));
    }

    const user = await fastify.prisma.user.create({
      data: {
        email: payload.email,
        username: null,
        displayName: payload.name ?? null,
        authProvider: 'GOOGLE',
        googleSub: payload.sub,
        role: 'CLIENT',
        wallet: { create: { balance: 0 } },
      },
      include: { host: true },
    });

    fastify.log.info({ userId: user.id, provider: 'GOOGLE', created: true }, 'Auth register ok');
    return reply.send(buildAuthResponse(user));
  });

  fastify.get('/auth/username-available', async (request) => {
    const query = z.object({ u: z.string().min(1).max(30) }).parse(request.query ?? {});
    const normalized = normalizeUsername(query.u);
    if (normalized.length < 3) {
      return { available: false, username: normalized };
    }
    const existing = await fastify.prisma.user.findUnique({
      where: { username: normalized },
      select: { id: true },
    });
    return { available: !existing, username: normalized };
  });

  fastify.post('/auth/set-username', async (request, reply) => {
    const schema = z.object({ username: z.string().min(3).max(30) });
    const body = schema.parse(request.body);
    const user = await requireUser(request, reply, fastify.prisma);
    if (!user) return;

    const normalized = normalizeUsername(body.username);
    if (normalized.length < 3) {
      return reply.status(400).send({ error: 'Username invalido' });
    }

    const existing = await fastify.prisma.user.findUnique({
      where: { username: normalized },
      select: { id: true },
    });
    if (existing && existing.id !== user.id) {
      return reply.status(409).send({ error: 'Username ja em uso' });
    }

    const updated = await fastify.prisma.user.update({
      where: { id: user.id },
      data: { username: normalized },
      include: { host: true },
    });

    if (updated.host) {
      await fastify.prisma.hostProfile.update({
        where: { id: updated.host.id },
        data: { displayName: normalized },
      });
    }

    fastify.log.info({ userId: updated.id, username: normalized }, 'Username set');
    return reply.send(buildAuthResponse(updated));
  });

  fastify.get('/auth/me', async (request, reply) => {
    const user = await requireUser(request, reply, fastify.prisma);
    if (!user) return;

    return reply.send({
      user: sanitizeUser(user),
      needsUsername: !user.username,
    });
  });
}
