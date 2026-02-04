-- DropForeignKey
ALTER TABLE "StreamConnectToken" DROP CONSTRAINT "StreamConnectToken_pcId_fkey";

-- DropForeignKey
ALTER TABLE "StreamConnectToken" DROP CONSTRAINT "StreamConnectToken_userId_fkey";

-- AddForeignKey
ALTER TABLE "StreamConnectToken" ADD CONSTRAINT "StreamConnectToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StreamConnectToken" ADD CONSTRAINT "StreamConnectToken_pcId_fkey" FOREIGN KEY ("pcId") REFERENCES "PC"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
