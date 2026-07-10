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

function parsePageArg(): number | undefined {
  const arg = process.argv.find((a) => a.startsWith("--page="));
  if (!arg) return undefined;
  const page = Number(arg.split("=")[1]);
  if (!Number.isInteger(page) || page < 1) {
    console.error(`Invalid --page value: ${arg}`);
    process.exit(1);
  }
  return page;
}

async function main() {
  const startPage = parsePageArg();
  console.log(
    `Starting incremental Crisp sync${startPage ? ` from page ${startPage}` : ""}...`
  );
  try {
    const result = await runIncrementalSync({ startPage });
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
