/**
 * Full sync of all Crisp conversations into the database.
 *
 *   npm run sync:crisp              # start from page 1
 *   npm run sync:crisp -- --page=42 # resume an interrupted run from page 42
 */
import "dotenv/config";
import { runFullSync } from "../src/lib/sync/sync-service";
import { getSyncProgress } from "../src/lib/sync/sync-state";
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
    `Starting full Crisp sync${startPage ? ` from page ${startPage}` : ""}...`
  );

  const ticker = setInterval(() => {
    const p = getSyncProgress();
    console.log(
      `  page=${p.currentPage ?? "-"} conversations=${p.conversationsSynced} messages=${p.messagesSynced}${
        p.failedSessions.length > 0 ? ` failed=${p.failedSessions.length}` : ""
      }`
    );
  }, 10_000);

  try {
    const result = await runFullSync({ startPage });
    clearInterval(ticker);
    console.log(
      `Sync ${result.status}: ${result.conversationsSynced} conversations, ${result.messagesSynced} messages (log ${result.syncLogId})`
    );
    if (result.failedSessions.length > 0) {
      console.warn(`Failed sessions (${result.failedSessions.length}):`);
      for (const sessionId of result.failedSessions) console.warn(`  - ${sessionId}`);
    }
    if (result.error) {
      console.error(`Error: ${result.error}`);
      process.exitCode = 1;
    }
  } finally {
    clearInterval(ticker);
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error("Sync crashed:", error);
  process.exit(1);
});
