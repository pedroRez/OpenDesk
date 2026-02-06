-- Add auth provider enum
CREATE TYPE "AuthProvider" AS ENUM ('PASSWORD', 'GOOGLE');

-- Add new auth fields
ALTER TABLE "User" ADD COLUMN "username" TEXT;
ALTER TABLE "User" ADD COLUMN "displayName" TEXT;
ALTER TABLE "User" ADD COLUMN "passwordHash" TEXT;
ALTER TABLE "User" ADD COLUMN "authProvider" "AuthProvider" NOT NULL DEFAULT 'PASSWORD';
ALTER TABLE "User" ADD COLUMN "googleSub" TEXT;
ALTER TABLE "User" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Backfill display name from legacy name
UPDATE "User" SET "displayName" = COALESCE("displayName", "name");

-- Backfill username with unique suffix
UPDATE "User"
SET "username" = CONCAT(
  COALESCE(NULLIF(lower(regexp_replace(split_part("email",'@',1), '[^a-zA-Z0-9_]+', '', 'g')), ''), 'user'),
  '-',
  substr(replace("id", '-', ''), 1, 6)
)
WHERE "username" IS NULL;

-- Ensure host display name uses username (public)
UPDATE "HostProfile" h
SET "displayName" = u."username"
FROM "User" u
WHERE h."userId" = u."id";

-- Enforce username not null and unique
ALTER TABLE "User" ALTER COLUMN "username" SET NOT NULL;
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");
CREATE UNIQUE INDEX "User_googleSub_key" ON "User"("googleSub");

-- Drop legacy name column
ALTER TABLE "User" DROP COLUMN "name";
