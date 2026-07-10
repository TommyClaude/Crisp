import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ragSearch } from "@/lib/rag/search";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  query: z.string().min(1, "query is required").max(1000),
  limit: z.coerce.number().int().min(1).max(50).default(8),
  source: z.enum(["crisp_chat", "plugin_docs"]).optional(),
  pluginId: z.string().optional(),
  brandId: z.string().optional(),
});

/**
 * GET /api/rag/search?query=...&limit=8[&source=][&pluginId=][&brandId=]
 * Returns the top matching chunks with their source conversation or docs
 * page. Modes: pgvector ANN → JSON-embedding cosine → keyword FTS fallback.
 */
export async function GET(request: NextRequest) {
  const params = Object.fromEntries(request.nextUrl.searchParams.entries());
  const parsed = querySchema.safeParse(params);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid query parameters", issues: parsed.error.issues },
      { status: 400 }
    );
  }

  try {
    const { query, ...options } = parsed.data;
    const response = await ragSearch(query, options);
    return NextResponse.json(response);
  } catch (error) {
    console.error("RAG search failed:", error);
    return NextResponse.json(
      { error: "Search failed", detail: String(error) },
      { status: 500 }
    );
  }
}
