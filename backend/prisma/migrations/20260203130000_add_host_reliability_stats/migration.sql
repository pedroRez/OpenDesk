-- AlterTable
ALTER TABLE "HostProfile"
ADD COLUMN     "sessionsTotal" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "sessionsCompleted" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "sessionsDropped" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lastDropAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "HostOnlineMinute" (
    "hostId" TEXT NOT NULL,
    "minute" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HostOnlineMinute_pkey" PRIMARY KEY ("hostId", "minute")
);

-- CreateIndex
CREATE INDEX "HostOnlineMinute_minute_idx" ON "HostOnlineMinute"("minute");

-- AddForeignKey
ALTER TABLE "HostOnlineMinute" ADD CONSTRAINT "HostOnlineMinute_hostId_fkey" FOREIGN KEY ("hostId") REFERENCES "HostProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
