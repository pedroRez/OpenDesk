-- CreateEnum
CREATE TYPE "PCCategory" AS ENUM ('GAMES', 'DESIGN', 'VIDEO', 'DEV', 'OFFICE');

-- AlterTable
ALTER TABLE "PC"
ADD COLUMN     "categories" "PCCategory"[] NOT NULL DEFAULT ARRAY[]::"PCCategory"[],
ADD COLUMN     "softwareTags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "specSummary" JSONB NOT NULL DEFAULT '{}'::jsonb,
ADD COLUMN     "description" TEXT NOT NULL DEFAULT '';

-- Backfill
UPDATE "PC"
SET "specSummary" = jsonb_build_object(
  'cpu', "cpu",
  'gpu', "gpu",
  'ram', ("ramGb"::text || ' GB')
);
