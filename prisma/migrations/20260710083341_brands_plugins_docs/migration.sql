-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "brandId" TEXT;

-- AlterTable
ALTER TABLE "EmbeddingChunk" ADD COLUMN     "docsPageId" TEXT,
ADD COLUMN     "pluginId" TEXT,
ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'crisp_chat',
ALTER COLUMN "conversationId" DROP NOT NULL;

-- CreateTable
CREATE TABLE "Brand" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "domain" TEXT,
    "crispWebsiteId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Brand_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Plugin" (
    "id" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "wpOrgSlug" TEXT,
    "detectionKeywords" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Plugin_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocsSource" (
    "id" TEXT NOT NULL,
    "pluginId" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'url',
    "url" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'idle',
    "lastCrawledAt" TIMESTAMP(3),
    "pageCount" INTEGER NOT NULL DEFAULT 0,
    "chunkCount" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DocsSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocsPage" (
    "id" TEXT NOT NULL,
    "docsSourceId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "title" TEXT,
    "contentText" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "lastCrawledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocsPage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Brand_slug_key" ON "Brand"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Brand_crispWebsiteId_key" ON "Brand"("crispWebsiteId");

-- CreateIndex
CREATE UNIQUE INDEX "Plugin_name_key" ON "Plugin"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Plugin_slug_key" ON "Plugin"("slug");

-- CreateIndex
CREATE INDEX "Plugin_brandId_idx" ON "Plugin"("brandId");

-- CreateIndex
CREATE INDEX "DocsSource_pluginId_idx" ON "DocsSource"("pluginId");

-- CreateIndex
CREATE UNIQUE INDEX "DocsPage_docsSourceId_url_key" ON "DocsPage"("docsSourceId", "url");

-- CreateIndex
CREATE INDEX "Conversation_brandId_idx" ON "Conversation"("brandId");

-- CreateIndex
CREATE INDEX "EmbeddingChunk_source_idx" ON "EmbeddingChunk"("source");

-- CreateIndex
CREATE INDEX "EmbeddingChunk_pluginId_idx" ON "EmbeddingChunk"("pluginId");

-- CreateIndex
CREATE INDEX "EmbeddingChunk_docsPageId_idx" ON "EmbeddingChunk"("docsPageId");

-- AddForeignKey
ALTER TABLE "Plugin" ADD CONSTRAINT "Plugin_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "Brand"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocsSource" ADD CONSTRAINT "DocsSource_pluginId_fkey" FOREIGN KEY ("pluginId") REFERENCES "Plugin"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocsPage" ADD CONSTRAINT "DocsPage_docsSourceId_fkey" FOREIGN KEY ("docsSourceId") REFERENCES "DocsSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "Brand"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmbeddingChunk" ADD CONSTRAINT "EmbeddingChunk_pluginId_fkey" FOREIGN KEY ("pluginId") REFERENCES "Plugin"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmbeddingChunk" ADD CONSTRAINT "EmbeddingChunk_docsPageId_fkey" FOREIGN KEY ("docsPageId") REFERENCES "DocsPage"("id") ON DELETE CASCADE ON UPDATE CASCADE;
