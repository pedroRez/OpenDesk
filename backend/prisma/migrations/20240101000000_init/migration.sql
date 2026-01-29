-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('CLIENT', 'HOST', 'ADMIN');
CREATE TYPE "PCLevel" AS ENUM ('A', 'B', 'C');
CREATE TYPE "PCStatus" AS ENUM ('ONLINE', 'OFFLINE', 'BUSY');
CREATE TYPE "SessionStatus" AS ENUM ('PENDING', 'ACTIVE', 'ENDED', 'FAILED');
CREATE TYPE "WalletTxType" AS ENUM ('CREDIT', 'DEBIT');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" "UserRole" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "HostProfile" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "reliabilityScore" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "HostProfile_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PC" (
    "id" TEXT NOT NULL,
    "hostId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "level" "PCLevel" NOT NULL,
    "cpu" TEXT NOT NULL,
    "ramGb" INTEGER NOT NULL,
    "gpu" TEXT NOT NULL,
    "vramGb" INTEGER NOT NULL,
    "storageType" TEXT NOT NULL,
    "internetUploadMbps" INTEGER NOT NULL,
    "pricePerHour" DOUBLE PRECISION NOT NULL,
    "status" "PCStatus" NOT NULL DEFAULT 'ONLINE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PC_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Software" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    CONSTRAINT "Software_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PCSoftware" (
    "pcId" TEXT NOT NULL,
    "softwareId" TEXT NOT NULL,
    CONSTRAINT "PCSoftware_pkey" PRIMARY KEY ("pcId", "softwareId")
);

CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "pcId" TEXT NOT NULL,
    "clientUserId" TEXT NOT NULL,
    "status" "SessionStatus" NOT NULL,
    "startAt" TIMESTAMP(3),
    "endAt" TIMESTAMP(3),
    "minutesPurchased" INTEGER NOT NULL,
    "minutesUsed" INTEGER NOT NULL DEFAULT 0,
    "priceTotal" DOUBLE PRECISION NOT NULL,
    "platformFee" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "hostPayout" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "clientCredit" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Wallet" (
    "userId" TEXT NOT NULL,
    "balance" DOUBLE PRECISION NOT NULL DEFAULT 0,
    CONSTRAINT "Wallet_pkey" PRIMARY KEY ("userId")
);

CREATE TABLE "WalletTx" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "WalletTxType" NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "reason" TEXT NOT NULL,
    "sessionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WalletTx_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
CREATE UNIQUE INDEX "HostProfile_userId_key" ON "HostProfile"("userId");

-- AddForeignKey
ALTER TABLE "HostProfile" ADD CONSTRAINT "HostProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PC" ADD CONSTRAINT "PC_hostId_fkey" FOREIGN KEY ("hostId") REFERENCES "HostProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PCSoftware" ADD CONSTRAINT "PCSoftware_pcId_fkey" FOREIGN KEY ("pcId") REFERENCES "PC"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PCSoftware" ADD CONSTRAINT "PCSoftware_softwareId_fkey" FOREIGN KEY ("softwareId") REFERENCES "Software"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Session" ADD CONSTRAINT "Session_pcId_fkey" FOREIGN KEY ("pcId") REFERENCES "PC"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Session" ADD CONSTRAINT "Session_clientUserId_fkey" FOREIGN KEY ("clientUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Wallet" ADD CONSTRAINT "Wallet_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WalletTx" ADD CONSTRAINT "WalletTx_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WalletTx" ADD CONSTRAINT "WalletTx_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE SET NULL ON UPDATE CASCADE;
