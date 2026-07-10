import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { generateSuggestionForThread } from "@/lib/suggest/suggester";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * POST /api/wporg/threads/:id/suggest
 * (Re)generates the reply suggestion for a thread: retrieves RAG context and,
 * when an LLM provider is configured, drafts the reply.
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
    return NextResponse.json({ error: "Thread not found" }, { status: 404 });
  }

  try {
    const result = await generateSuggestionForThread(id);
    return NextResponse.json(result);
  } catch (error) {
    console.error(`Suggestion failed for thread ${id}:`, error);
    return NextResponse.json(
      { error: "Suggestion failed", detail: String(error) },
      { status: 500 }
    );
  }
}
