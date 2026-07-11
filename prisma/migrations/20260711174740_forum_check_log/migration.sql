-- CreateTable
CREATE TABLE "ForumCheckLog" (
    "id" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'running',
    "pluginsChecked" INTEGER NOT NULL DEFAULT 0,
    "newThreads" INTEGER NOT NULL DEFAULT 0,
    "drafted" INTEGER NOT NULL DEFAULT 0,
    "skippedOld" INTEGER NOT NULL DEFAULT 0,
    "lastIndex" INTEGER,
    "errors" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "ForumCheckLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ForumCheckLog_startedAt_idx" ON "ForumCheckLog"("startedAt");

-- CreateIndex
CREATE INDEX "ForumCheckLog_status_idx" ON "ForumCheckLog"("status");
