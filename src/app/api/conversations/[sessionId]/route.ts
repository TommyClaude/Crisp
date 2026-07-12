import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getConversationDetail } from "@/lib/conversations";

export const dynamic = "force-dynamic";

/**
 * GET /api/conversations/:sessionId
 * Full conversation detail: metadata, all messages (chronological),
 * attachments, assigned operator and chunk summaries.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params;
  const conversation = await getConversationDetail(sessionId);
  if (!conversation) {
    return NextResponse.json(
      { error: `Conversation ${sessionId} not found` },
      { status: 404 }
    );
  }
  return NextResponse.json({ conversation });
}

const patchSchema = z.object({ junk: z.boolean() });

/**
 * PATCH /api/conversations/:sessionId
 * Body `{ junk: boolean }` — the human veto over the auto-classifier. Sets
 * isJunk, a "marked manually" junkReason (null when clearing) and, crucially,
 * junkOverride = true so no future sync or scan ever overwrites this decision.
 *
 * Turning junk ON deletes the conversation's RAG chunks immediately (reported
 * as `cleaned`) so the AI stops learning from it. Turning junk OFF does NOT
 * auto-rebuild — the next rebuild/sync pass re-chunks it.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params;

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = patchSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request", issues: parsed.error.issues },
      { status: 400 }
    );
  }
  const { junk } = parsed.data;

  const conversation = await prisma.conversation.findUnique({
    where: { sessionId },
    select: { id: true },
  });
  if (!conversation) {
    return NextResponse.json(
      { error: `Conversation ${sessionId} not found` },
      { status: 404 }
    );
  }

  await prisma.conversation.update({
    where: { id: conversation.id },
    data: {
      isJunk: junk,
      junkReason: junk ? "marked manually" : null,
      junkOverride: true,
    },
  });

  let cleaned = 0;
  if (junk) {
    const deleted = await prisma.embeddingChunk.deleteMany({
      where: { conversationId: conversation.id },
    });
    cleaned = deleted.count;
  }

  return NextResponse.json({
    ok: true,
    isJunk: junk,
    junkReason: junk ? "marked manually" : null,
    junkOverride: true,
    cleaned,
  });
}
