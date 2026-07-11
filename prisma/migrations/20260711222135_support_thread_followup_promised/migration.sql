-- AlterTable
ALTER TABLE "SupportThread" ADD COLUMN     "followupPromisedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "SupportThread_followupPromisedAt_idx" ON "SupportThread"("followupPromisedAt");
