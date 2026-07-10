/**
 * Incremental Crisp sync — only conversations updated since the last
 * successful run (with a 1-hour overlap). Falls back to a full sync when the
 * database has never been synced. Designed to be run from cron, e.g.:
 *
 *   *\/30 * * * *  cd /path/to/app && npm run sync:crisp:incremental
 */
import "dotenv/config";
import { runIncrementalSync } from "../src/lib/sync/sync-service";
import { prisma } from "../src/lib/db";

async function main() {
  console.log("Starting incremental Crisp sync...");
  try {
    const result = await runIncrementalSync();
    console.log(
      `Sync ${result.status}: ${result.conversationsSynced} conversations, ${result.messagesSynced} messages (log ${result.syncLogId})`
    );
    if (result.failedSessions.length > 0) {
      console.warn(`Failed sessions: ${result.failedSessions.join(", ")}`);
    }
    if (result.error) {
      console.error(`Error: ${result.error}`);
      process.exitCode = 1;
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error("Sync crashed:", error);
  process.exit(1);
});
