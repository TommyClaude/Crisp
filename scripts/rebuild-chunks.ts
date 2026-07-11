/**
 * Rebuild RAG chunks (and embeddings, when OPENAI_API_KEY is set) from the
 * synced messages.
 *
 *   npm run rag:rebuild                 # resolved conversations only
 *   npm run rag:rebuild -- --all        # every conversation
 *   npm run rag:rebuild -- --no-embed   # skip embedding generation
 */
import "dotenv/config";
import { rebuildAllChunks } from "../src/lib/rag/rebuild";
import { prisma } from "../src/lib/db";

async function main() {
  const onlyResolved = !process.argv.includes("--all");
  const withEmbeddings = !process.argv.includes("--no-embed");
  console.log(
    `Rebuilding chunks (${onlyResolved ? "resolved only" : "all conversations"}, embeddings ${withEmbeddings ? "on" : "off"})...`
  );

  try {
    const result = await rebuildAllChunks({
      onlyResolved,
      withEmbeddings,
      onProgress: (done, total) => {
        if (done % 25 === 0 || done === total) {
          console.log(`  ${done}/${total} conversations processed`);
        }
      },
    });
    console.log(
      `Done: ${result.chunks} chunks from ${result.conversations} conversations` +
        (result.skipped > 0 ? `, ${result.skipped} skipped as unchunkable` : "") +
        (result.purged > 0
          ? `, ${result.purged} stale conversations purged`
          : "") +
        "."
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

main().catch((error) => {
  console.error("Rebuild crashed:", error);
  process.exit(1);
});
