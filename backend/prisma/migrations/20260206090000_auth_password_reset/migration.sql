-- Make username optional for Google-first users
ALTER TABLE "User" ALTER COLUMN "username" DROP NOT NULL;

-- Password reset tokens
CREATE TABLE "PasswordResetToken" (
  "tokenHash" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "usedAt" TIMESTAMP(3),
  CONSTRAINT "PasswordResetToken_pkey" PRIMARY KEY ("tokenHash")
);

CREATE INDEX "PasswordResetToken_userId_expiresAt_idx" ON "PasswordResetToken"("userId", "expiresAt");

ALTER TABLE "PasswordResetToken" ADD CONSTRAINT "PasswordResetToken_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- OAuth PKCE state storage
CREATE TABLE "OAuthState" (
  "state" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "codeVerifier" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "OAuthState_pkey" PRIMARY KEY ("state")
);
