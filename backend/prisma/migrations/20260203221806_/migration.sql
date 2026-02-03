-- DropForeignKey
ALTER TABLE "HostOnlineMinute" DROP CONSTRAINT "HostOnlineMinute_hostId_fkey";

-- AddForeignKey
ALTER TABLE "HostOnlineMinute" ADD CONSTRAINT "HostOnlineMinute_hostId_fkey" FOREIGN KEY ("hostId") REFERENCES "HostProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
