import { NextRequest, NextResponse } from "next/server";
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
