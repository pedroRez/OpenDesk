-- Add PROMOTED status to QueueEntryStatus enum
DO $$ BEGIN
  ALTER TYPE "QueueEntryStatus" ADD VALUE IF NOT EXISTS 'PROMOTED';
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- Add startBy column to QueueEntry
ALTER TABLE "QueueEntry" ADD COLUMN IF NOT EXISTS "startBy" TIMESTAMP(3);
