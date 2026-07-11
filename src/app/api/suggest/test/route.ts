import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { prisma } from "@/lib/db";
import { suggesterConfigured } from "@/lib/suggest/llm";
import { draftSuggestion } from "@/lib/suggest/suggester";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * POST /api/suggest/test
 * Body: { pluginId, title?, content }
 * Playground endpoint: drafts reply suggestions for a hypothetical support
 * question using the same RAG + LLM pipeline as the real forum flow, WITHOUT
 * persisting a SupportThread. Returns the drafts, grounding context and status
 * so answer quality can be tested against the current knowledge base.
 */
const bodySchema = z.object({
  pluginId: z.string().min(1, "pluginId is required"),
  title: z.string().max(300).optional(),
  content: z
    .string()
    .min(10, "content must be at least 10 characters")
    .max(5000, "content must be at most 5000 characters"),
});

export async function POST(request: NextRequest) {
  let json: unknown;
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

  const { pluginId, title, content } = parsed.data;
  const plugin = await prisma.plugin.findUnique({
    where: { id: pluginId },
    select: { id: true, name: true },
  });
  if (!plugin) {
    return NextResponse.json({ error: "Plugin not found" }, { status: 404 });
  }

  // Fall back to the first ~80 chars of the body when no title is supplied,
  // mirroring how a wp.org topic's title seeds the retrieval query.
  const effectiveTitle = title?.trim() || content.trim().slice(0, 80);

  try {
    const { drafts, contextChunks, status, suggestError } =
      await draftSuggestion({
        title: effectiveTitle,
        excerpt: content,
        author: null,
        plugin,
      });
    return NextResponse.json({
      drafts,
      contextChunks,
      status,
      suggestError,
      llmConfigured: suggesterConfigured(),
    });
  } catch (error) {
    console.error("Test-answer suggestion failed:", error);
    return NextResponse.json(
      { error: "Suggestion failed", detail: String(error) },
      { status: 500 }
    );
  }
}
