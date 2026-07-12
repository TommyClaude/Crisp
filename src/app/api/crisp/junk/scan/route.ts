import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { classifyJunk } from "@/lib/crisp/junk";
import { getSyncProgress } from "@/lib/sync/sync-state";

export const dynamic = "force-dynamic";

/** Conversations per batch — keeps memory flat as the archive grows. */
const BATCH_SIZE = 500;

/**
 * POST /api/crisp/junk/scan
 *
 * Re-classify every conversation the auto-classifier is allowed to touch
 * (junkOverride === false) against the current rules in src/lib/crisp/junk.ts,
 * and purge the RAG chunks of any conversation that newly became junk so the
 * AI stops learning from it. The manual mark/clear (junkOverride) is never
 * revisited here — a human's veto always wins.
 *
 * Cursor-paginated over id in {@link BATCH_SIZE} batches (select id + fields,
 * classify in JS, one updateMany per (junk, reason) group per batch), so memory
 * stays flat whether the archive is 1.3k rows today or tens of thousands later.
 *
 * Returns `{ scanned, junk, byReason, cleaned }` where `cleaned` is the number
 * of RAG chunks deleted for conversations that flipped TO junk this scan.
 *
 * `409` while a sync is running: the sync loop runs the same classifier and
 * writes the same isJunk/junkReason/chunks, so scanning concurrently would race
 * it. Waiting costs nothing.
 */
export async function POST() {
  const progress = getSyncProgress();
  if (progress.running) {
    return NextResponse.json(
      { error: "A sync is running — scan for junk when it finishes.", progress },
      { status: 409 }
    );
  }

  let scanned = 0;
  let junk = 0;
  let cleaned = 0;
  const byReason: Record<string, number> = {};

  // Cursor pagination by id. The junkOverride filter and the id ordering are
  // stable across the whole scan (we only ever write isJunk/junkReason, never
  // junkOverride or id), so the cursor never skips or repeats a row.
  let cursor: string | undefined;
  for (;;) {
    const batch = await prisma.conversation.findMany({
      where: {
        junkOverride: false,
        ...(cursor ? { id: { gt: cursor } } : {}),
      },
      orderBy: { id: "asc" },
      take: BATCH_SIZE,
      select: {
        id: true,
        visitorEmail: true,
        lastMessagePreview: true,
        isJunk: true,
      },
    });
    if (batch.length === 0) break;

    // Operator message counts for this batch in one grouped query — only
    // conversations that HAVE an operator message appear, so a missing id means
    // zero (never answered), which is exactly what the notification rule wants.
    const operatorCounts = await prisma.message.groupBy({
      by: ["conversationId"],
      where: {
        conversationId: { in: batch.map((c) => c.id) },
        from: "operator",
        // Private notes and events are not replies (chunker convention) — an
        // operator annotating a junk notification must not make it "answered".
        type: { notIn: ["note", "event"] },
      },
      _count: true,
    });
    const operatorCountById = new Map(
      operatorCounts.map((row) => [row.conversationId, row._count])
    );

    // Classify in JS, group ids by (junk, reason) for one updateMany per group,
    // and remember which conversations newly flipped TO junk so their chunks
    // can be purged and counted as `cleaned`.
    const groups = new Map<
      string,
      { junk: boolean; reason: string | null; ids: string[] }
    >();
    const newlyJunkIds: string[] = [];
    for (const conv of batch) {
      const result = classifyJunk({
        visitorEmail: conv.visitorEmail,
        lastMessagePreview: conv.lastMessagePreview,
        operatorMessageCount: operatorCountById.get(conv.id) ?? 0,
        userMessageCount: 0,
      });
      scanned += 1;
      if (result.junk) {
        junk += 1;
        if (result.reason) {
          byReason[result.reason] = (byReason[result.reason] ?? 0) + 1;
        }
        if (!conv.isJunk) newlyJunkIds.push(conv.id);
      }
      const key = `${result.junk}|${result.reason ?? ""}`;
      const group = groups.get(key);
      if (group) group.ids.push(conv.id);
      else {
        groups.set(key, {
          junk: result.junk,
          reason: result.reason,
          ids: [conv.id],
        });
      }
    }

    // One updateMany per (junk, reason) group. The junkOverride:false guard is
    // repeated so a row a human vetoed between the read and the write is never
    // clobbered.
    for (const group of groups.values()) {
      await prisma.conversation.updateMany({
        where: { id: { in: group.ids }, junkOverride: false },
        data: { isJunk: group.junk, junkReason: group.reason },
      });
    }

    // Purge chunks for conversations that just became junk. Flipping the other
    // way (junk → not junk) never auto-rebuilds — the next rebuild/sync pass
    // re-chunks it.
    if (newlyJunkIds.length > 0) {
      const deleted = await prisma.embeddingChunk.deleteMany({
        where: { conversationId: { in: newlyJunkIds } },
      });
      cleaned += deleted.count;
    }

    cursor = batch[batch.length - 1].id;
    if (batch.length < BATCH_SIZE) break;
  }

  return NextResponse.json({ scanned, junk, byReason, cleaned });
}
