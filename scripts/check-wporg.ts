/**
 * Poll the WordPress.org support forums of every plugin with a wpOrgSlug,
 * store new threads and draft reply suggestions. Cron-friendly, e.g.:
 *
 *   0 * * * *  cd /path/to/app && npm run wporg:check
 *
 *   npm run wporg:check                  # check + draft suggestions
 *   npm run wporg:check -- --no-suggest  # only fetch new threads
 */
import "dotenv/config";
import { checkPluginForums } from "../src/lib/wporg/watcher";
import { prisma } from "../src/lib/db";

async function main() {
  const withSuggestions = !process.argv.includes("--no-suggest");
  console.log(
    `Checking wp.org support forums${withSuggestions ? " (with draft suggestions)" : ""}...`
  );
  try {
    const result = await checkPluginForums({ withSuggestions });
    console.log(
      `Done: ${result.pluginsChecked} plugins checked, ${result.newThreads} new threads, ` +
        `${result.drafted} drafts generated, ${result.skippedOld} skipped (too old).`
    );
    if (result.errors.length > 0) {
      console.warn(`Errors (${result.errors.length}):`);
      for (const line of result.errors) console.warn(`  - ${line}`);
      process.exitCode = 1;
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch(async (error) => {
  console.error("Forum check crashed:", error);
  await prisma.$disconnect();
  process.exit(1);
});
