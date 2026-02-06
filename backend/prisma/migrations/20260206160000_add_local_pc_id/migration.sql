-- Add localPcId to PC
ALTER TABLE "PC" ADD COLUMN "localPcId" TEXT;

-- Unique per host + localPcId (allows multiple NULLs)
CREATE UNIQUE INDEX "PC_hostId_localPcId_key" ON "PC"("hostId", "localPcId");
