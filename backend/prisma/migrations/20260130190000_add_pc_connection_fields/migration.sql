-- AlterTable
ALTER TABLE "PC"
ADD COLUMN     "connectionHost" TEXT,
ADD COLUMN     "connectionPort" INTEGER DEFAULT 47990,
ADD COLUMN     "connectionNotes" TEXT;
