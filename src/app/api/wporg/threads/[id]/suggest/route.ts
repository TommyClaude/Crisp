import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { generateFollowupForThread } from "@/lib/suggest/followup";
import { generateSuggestionForThread } from "@/lib/suggest/suggester";

export const dynamic = "force-dynamic";
// Two sequential passes (first-reply + follow-up), each with up to two LLM
// calls plus a multi-page wp.org fetch — mirror the heavier crawl routes.
export const maxDuration = 300;

/**
 * POST /api/wporg/threads/:id/suggest
 * (Re)generates the reply suggestion for a thread: retrieves RAG context and,
 * when an LLM provider is configured, drafts the reply.
 *
 * The manual Regenerate button ALSO drafts a follow-up reply grounded on the
 * whole live wp.org thread (the next reply the support team should post). This
 * extra pass is exclusive to this route — the watcher and bulk generators keep
 * the cheaper first-reply-only behavior for cost control. A follow-up failure
 * (e.g. wp.org unreachable) never fails the request: the first-reply drafts
 * are already persisted, and the follow-up records a skipped state instead.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const exists = await prisma.supportThread.findUnique({
    where: { id },
    select: { id: true },
  });
  if (!exists) {
    return NextResponse.json({ error: "Topic not found" }, { status: 404 });
  }

  try {
    const result = await generateSuggestionForThread(id);

    // Follow-up drafts are best-effort: fetching the live thread or the extra
    // LLM calls can fail without invalidating the first-reply drafts above.
    let followup = null;
    try {
      followup = await generateFollowupForThread(id);
    } catch (error) {
      console.error(`Follow-up draft failed for thread ${id}:`, error);
    }

    return NextResponse.json({ ...result, followup });
  } catch (error) {
    console.error(`Suggestion failed for thread ${id}:`, error);
    return NextResponse.json(
      { error: "Suggestion failed", detail: String(error) },
      { status: 500 }
    );
  }
}
