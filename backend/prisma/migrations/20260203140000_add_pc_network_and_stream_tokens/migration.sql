-- CreateEnum
CREATE TYPE "NetworkProvider" AS ENUM ('DIRECT', 'RELAY');

-- AlterTable
ALTER TABLE "PC"
ADD COLUMN     "networkProvider" "NetworkProvider" NOT NULL DEFAULT 'DIRECT',
ADD COLUMN     "connectAddress" TEXT,
ADD COLUMN     "connectHint" TEXT;

-- CreateTable
CREATE TABLE "StreamConnectToken" (
    "token" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "pcId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),

    CONSTRAINT "StreamConnectToken_pkey" PRIMARY KEY ("token")
);

-- CreateIndex
CREATE INDEX "StreamConnectToken_pcId_expiresAt_idx" ON "StreamConnectToken"("pcId", "expiresAt");
CREATE INDEX "StreamConnectToken_userId_expiresAt_idx" ON "StreamConnectToken"("userId", "expiresAt");

-- AddForeignKey
ALTER TABLE "StreamConnectToken" ADD CONSTRAINT "StreamConnectToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StreamConnectToken" ADD CONSTRAINT "StreamConnectToken_pcId_fkey" FOREIGN KEY ("pcId") REFERENCES "PC"("id") ON DELETE CASCADE ON UPDATE CASCADE;
