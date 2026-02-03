-- CreateTable
CREATE TABLE "Favorite" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "pcId" TEXT,
    "hostId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Favorite_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Favorite_userId_pcId_key" ON "Favorite"("userId", "pcId");
CREATE UNIQUE INDEX "Favorite_userId_hostId_key" ON "Favorite"("userId", "hostId");
CREATE INDEX "Favorite_userId_createdAt_idx" ON "Favorite"("userId", "createdAt");

-- AddCheckConstraint
ALTER TABLE "Favorite" ADD CONSTRAINT "Favorite_one_target_check"
CHECK (
  ("pcId" IS NOT NULL AND "hostId" IS NULL)
  OR
  ("pcId" IS NULL AND "hostId" IS NOT NULL)
);

-- AddForeignKey
ALTER TABLE "Favorite" ADD CONSTRAINT "Favorite_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Favorite" ADD CONSTRAINT "Favorite_pcId_fkey" FOREIGN KEY ("pcId") REFERENCES "PC"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Favorite" ADD CONSTRAINT "Favorite_hostId_fkey" FOREIGN KEY ("hostId") REFERENCES "HostProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
