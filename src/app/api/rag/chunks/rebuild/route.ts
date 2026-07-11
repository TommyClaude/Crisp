import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import {
  rebuildAllChunks,
  rebuildChunksForConversation,
} from "@/lib/rag/rebuild";

export const dynamic = "force-dynamic";

const bodySchema = z
  .object({
    sessionId: z.string().optional(),
    onlyResolved: z.boolean().default(true),
    withEmbeddings: z.boolean().default(true),
  })
  .default({ onlyResolved: true, withEmbeddings: true });

const globalForRebuild = globalThis as unknown as { ragRebuildRunning?: boolean };

/**
 * POST /api/rag/chunks/rebuild
 * Body: { sessionId?: string, onlyResolved?: boolean, withEmbeddings?: boolean }
 *
 * With a sessionId: rebuilds chunks for that conversation synchronously.
 * Without: kicks off a background rebuild of all (resolved) conversations.
 */
export async function POST(request: NextRequest) {
  let json: unknown = {};
  try {
    const text = await request.text();
    json = text ? JSON.parse(text) : {};
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request", issues: parsed.error.issues },
      { status: 400 }
    );
  }
  const { sessionId, onlyResolved, withEmbeddings } = parsed.data;

  if (sessionId) {
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
    try {
      const result = await rebuildChunksForConversation(conversation.id, {
        withEmbeddings,
      });
      return NextResponse.json({ rebuilt: true, ...result });
    } catch (error) {
      console.error(`Chunk rebuild failed for ${sessionId}:`, error);
      return NextResponse.json(
        { error: "Chunk rebuild failed", detail: String(error) },
        { status: 500 }
      );
    }
  }

  if (globalForRebuild.ragRebuildRunning) {
    return NextResponse.json(
      { error: "A full chunk rebuild is already running" },
      { status: 409 }
    );
  }
  globalForRebuild.ragRebuildRunning = true;
  rebuildAllChunks({ onlyResolved, withEmbeddings })
    .then((result) =>
      console.log(
        `Chunk rebuild finished: ${result.chunks} chunks from ${result.conversations} conversations` +
          (result.skipped > 0
            ? `, ${result.skipped} skipped as unchunkable`
            : "") +
          (result.purged > 0
            ? `, ${result.purged} stale conversations purged`
            : "") +
          (result.errors.length > 0 ? `, ${result.errors.length} errors` : "")
      )
    )
    .catch((error) => console.error("Chunk rebuild failed:", error))
    .finally(() => {
      globalForRebuild.ragRebuildRunning = false;
    });

  return NextResponse.json({ started: true, onlyResolved, withEmbeddings }, { status: 202 });
}
