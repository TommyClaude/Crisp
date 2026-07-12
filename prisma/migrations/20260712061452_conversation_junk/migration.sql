-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "isJunk" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "junkOverride" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "junkReason" TEXT;

-- CreateIndex
CREATE INDEX "Conversation_isJunk_idx" ON "Conversation"("isJunk");
