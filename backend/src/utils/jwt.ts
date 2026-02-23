import jwt from 'jsonwebtoken';
import type { Secret, SignOptions } from 'jsonwebtoken';

type JwtPayload = {
  sub: string;
  role?: string;
};

const secret: Secret = process.env.JWT_SECRET ?? 'dev-secret-change-me';
const expiresIn: SignOptions['expiresIn'] =
  (process.env.JWT_EXPIRES_IN as SignOptions['expiresIn'] | undefined) ?? '7d';

export function signAccessToken(payload: JwtPayload): string {
  return jwt.sign(payload, secret, { expiresIn });
}

export function verifyAccessToken(token: string): JwtPayload | null {
  try {
    const decoded = jwt.verify(token, secret) as JwtPayload;
    if (!decoded?.sub) {
      return null;
    }
    return decoded;
  } catch {
    return null;
  }
}
