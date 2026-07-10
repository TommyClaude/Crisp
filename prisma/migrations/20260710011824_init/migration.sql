-- CreateTable
CREATE TABLE "Conversation" (
    "id" TEXT NOT NULL,
    "websiteId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "state" TEXT,
    "inbox" TEXT,
    "createdAtCrisp" TIMESTAMP(3),
    "updatedAtCrisp" TIMESTAMP(3),
    "lastMessageAt" TIMESTAMP(3),
    "lastMessagePreview" TEXT,
    "visitorEmail" TEXT,
    "visitorNickname" TEXT,
    "visitorAvatar" TEXT,
    "visitorPhone" TEXT,
    "visitorUserId" TEXT,
    "country" TEXT,
    "city" TEXT,
    "ip" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "assignedOperatorId" TEXT,
    "rawJson" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "crispMessageId" TEXT,
    "sessionId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "from" TEXT NOT NULL,
    "origin" TEXT,
    "userId" TEXT,
    "operatorId" TEXT,
    "content" TEXT,
    "contentJson" JSONB,
    "timestampCrisp" TIMESTAMP(3),
    "rawJson" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Operator" (
    "id" TEXT NOT NULL,
    "crispUserId" TEXT NOT NULL,
    "name" TEXT,
    "email" TEXT,
    "avatar" TEXT,
    "rawJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Operator_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConversationFile" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "messageId" TEXT,
    "sessionId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "filename" TEXT,
    "mimeType" TEXT,
    "size" INTEGER,
    "rawJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConversationFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmbeddingChunk" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "chunkIndex" INTEGER NOT NULL DEFAULT 0,
    "messageIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "chunkText" TEXT NOT NULL,
    "product" TEXT,
    "topic" TEXT,
    "language" TEXT,
    "embeddingJson" JSONB,
    "rawJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmbeddingChunk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncLog" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'full',
    "status" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "pageFrom" INTEGER,
    "pageTo" INTEGER,
    "conversationsSynced" INTEGER NOT NULL DEFAULT 0,
    "messagesSynced" INTEGER NOT NULL DEFAULT 0,
    "failedSessions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "error" TEXT,

    CONSTRAINT "SyncLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Conversation_sessionId_key" ON "Conversation"("sessionId");

-- CreateIndex
CREATE INDEX "Conversation_websiteId_idx" ON "Conversation"("websiteId");

-- CreateIndex
CREATE INDEX "Conversation_state_idx" ON "Conversation"("state");

-- CreateIndex
CREATE INDEX "Conversation_visitorEmail_idx" ON "Conversation"("visitorEmail");

-- CreateIndex
CREATE INDEX "Conversation_updatedAtCrisp_idx" ON "Conversation"("updatedAtCrisp");

-- CreateIndex
CREATE INDEX "Conversation_lastMessageAt_idx" ON "Conversation"("lastMessageAt");

-- CreateIndex
CREATE INDEX "Conversation_assignedOperatorId_idx" ON "Conversation"("assignedOperatorId");

-- CreateIndex
CREATE INDEX "Conversation_tags_idx" ON "Conversation" USING GIN ("tags");

-- CreateIndex
CREATE INDEX "Message_conversationId_idx" ON "Message"("conversationId");

-- CreateIndex
CREATE INDEX "Message_sessionId_idx" ON "Message"("sessionId");

-- CreateIndex
CREATE INDEX "Message_timestampCrisp_idx" ON "Message"("timestampCrisp");

-- CreateIndex
CREATE INDEX "Message_from_idx" ON "Message"("from");

-- CreateIndex
CREATE UNIQUE INDEX "Message_sessionId_crispMessageId_key" ON "Message"("sessionId", "crispMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "Operator_crispUserId_key" ON "Operator"("crispUserId");

-- CreateIndex
CREATE INDEX "ConversationFile_conversationId_idx" ON "ConversationFile"("conversationId");

-- CreateIndex
CREATE INDEX "ConversationFile_sessionId_idx" ON "ConversationFile"("sessionId");

-- CreateIndex
CREATE INDEX "EmbeddingChunk_conversationId_idx" ON "EmbeddingChunk"("conversationId");

-- CreateIndex
CREATE INDEX "EmbeddingChunk_product_idx" ON "EmbeddingChunk"("product");

-- CreateIndex
CREATE INDEX "EmbeddingChunk_language_idx" ON "EmbeddingChunk"("language");

-- CreateIndex
CREATE INDEX "SyncLog_status_idx" ON "SyncLog"("status");

-- CreateIndex
CREATE INDEX "SyncLog_startedAt_idx" ON "SyncLog"("startedAt");

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_assignedOperatorId_fkey" FOREIGN KEY ("assignedOperatorId") REFERENCES "Operator"("crispUserId") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationFile" ADD CONSTRAINT "ConversationFile_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationFile" ADD CONSTRAINT "ConversationFile_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmbeddingChunk" ADD CONSTRAINT "EmbeddingChunk_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
