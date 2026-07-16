/**
 * Diagnose why a wp.org topic is (or isn't) in the Needs-resolved digest.
 *
 *   npx tsx scripts/diagnose-topic.ts https://wordpress.org/support/topic/some-topic/
 *
 * Read-only: prints the stored SupportThread row, then fetches the LIVE topic
 * page from wordpress.org (from THIS machine, so it sees exactly what the
 * digest's verification pass sees) and reports what the parser extracted —
 * posts found, resolved flag, last post's role — plus whether the row
 * currently matches the digest's candidate query. Nothing is written.
 */
import { getEnv } from "@/env";
import { prisma } from "@/lib/db";
import { silenceNudgeCutoff } from "@/lib/suggest/promise";
import { needsResolvedWhere } from "@/lib/suggest/suggestions-view";
import { fetchTopicThread } from "@/lib/wporg/forum-crawler";
import { canonicalizeTopicUrl } from "@/lib/wporg/topic-url";
import { topicLookupOr } from "@/lib/wporg/watcher";

async function main() {
  const rawUrl = process.argv[2];
  if (!rawUrl) {
    console.error("Usage: npx tsx scripts/diagnose-topic.ts <topic-url>");
    process.exit(1);
  }
  const canonical = canonicalizeTopicUrl(rawUrl) ?? rawUrl;
  console.log(`Topic: ${canonical}\n`);

  // 1) The stored row, matched the same lenient way the ingestion paths match.
  const row = await prisma.supportThread.findFirst({
    where: { OR: topicLookupOr(canonical, [rawUrl]) },
    include: { plugin: { select: { name: true, wpOrgSlug: true } } },
  });
  if (!row) {
    console.log("DB row: NOT FOUND — this topic is not tracked at all.");
  } else {
    console.log("DB row:");
    console.log(`  plugin:             ${row.plugin.name} (slug: ${row.plugin.wpOrgSlug ?? "none"})`);
    console.log(`  status:             ${row.status}`);
    console.log(`  wpResolved:         ${row.wpResolved}`);
    console.log(`  hasNewReply:        ${row.hasNewReply}`);
    console.log(`  waitingSince:       ${row.waitingSince?.toISOString() ?? "null"}`);
    console.log(`  followupPromisedAt: ${row.followupPromisedAt?.toISOString() ?? "null"}`);
    console.log(`  updatedAt:          ${row.updatedAt.toISOString()}`);

    const cutoff = silenceNudgeCutoff(getEnv().WPORG_SILENCE_NUDGE_DAYS, new Date());
    const candidate = await prisma.supportThread.findFirst({
      where: { AND: [{ id: row.id }, needsResolvedWhere(cutoff)] },
      select: { id: true },
    });
    console.log(`  digest candidate:   ${candidate ? "YES — would appear in the next digest" : "no"}`);
  }

  // 2) The live page, exactly as the verification pass fetches it.
  console.log("\nFetching the live topic page from wordpress.org...");
  const fetched = await fetchTopicThread(canonical);
  if (!fetched) {
    console.log("LIVE FETCH FAILED — network error, HTTP error, or rate limit.");
    console.log("This is why verification cannot update the row from this machine.");
  } else {
    console.log("Live page parsed:");
    console.log(`  title:      ${fetched.title ?? "(none)"}`);
    console.log(`  resolved:   ${fetched.resolved}`);
    console.log(`  posts:      ${fetched.posts.length}`);
    if (fetched.posts.length > 0) {
      const last = fetched.posts[fetched.posts.length - 1];
      console.log(`  last post:  by ${last.author ?? "?"} (${last.role ?? "customer"})`);
    }
    if (row) {
      console.log("\nVerdict:");
      if (fetched.resolved && !row.wpResolved) {
        console.log(
          "  MISMATCH: the live page is resolved but the DB row is not — the"
        );
        console.log(
          "  verification pass is failing between fetch and write. Send this"
        );
        console.log("  whole output to the developer.");
      } else if (fetched.resolved === row.wpResolved) {
        console.log("  DB and live page AGREE — the digest should reflect this state.");
      } else {
        console.log("  DB says resolved but the live page does not — unusual; send this output.");
      }
    }
  }
  await prisma.$disconnect();
}

main().catch((error) => {
  console.error("diagnose-topic failed:", error);
  process.exit(1);
});
