-- CreateTable
CREATE TABLE "SupportThread" (
    "id" TEXT NOT NULL,
    "pluginId" TEXT NOT NULL,
    "guid" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "author" TEXT,
    "excerpt" TEXT NOT NULL,
    "publishedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'new',
    "draftAnswer" TEXT,
    "draftModel" TEXT,
    "contextJson" JSONB,
    "suggestError" TEXT,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupportThread_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SupportThread_status_idx" ON "SupportThread"("status");

-- CreateIndex
CREATE INDEX "SupportThread_publishedAt_idx" ON "SupportThread"("publishedAt");

-- CreateIndex
CREATE UNIQUE INDEX "SupportThread_pluginId_guid_key" ON "SupportThread"("pluginId", "guid");

-- AddForeignKey
ALTER TABLE "SupportThread" ADD CONSTRAINT "SupportThread_pluginId_fkey" FOREIGN KEY ("pluginId") REFERENCES "Plugin"("id") ON DELETE CASCADE ON UPDATE CASCADE;
