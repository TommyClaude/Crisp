-- AlterTable
ALTER TABLE "SyncLog" ADD COLUMN     "brandId" TEXT;

-- CreateIndex
CREATE INDEX "SyncLog_brandId_idx" ON "SyncLog"("brandId");
