import { NextRequest, NextResponse } from "next/server";
import { CrispApiError } from "@/lib/crisp/client";
import { resyncConversation } from "@/lib/sync/sync-service";

export const dynamic = "force-dynamic";

/**
 * POST /api/sync/crisp/conversation/:sessionId
 * Re-fetches a single conversation (and all its messages) from Crisp,
 * upserts it, and rebuilds its RAG chunks.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params;
  if (!sessionId) {
    return NextResponse.json({ error: "sessionId is required" }, { status: 400 });
  }

  try {
    const result = await resyncConversation(sessionId);
    return NextResponse.json({ resynced: true, ...result });
  } catch (error) {
    if (error instanceof CrispApiError) {
      const status = error.status === 404 ? 404 : 502;
      return NextResponse.json(
        { error: error.message, crispStatus: error.status },
        { status }
      );
    }
    console.error(`Resync failed for ${sessionId}:`, error);
    return NextResponse.json(
      { error: "Resync failed", detail: String(error) },
      { status: 500 }
    );
  }
}
