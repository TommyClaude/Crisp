import { NextResponse } from "next/server";

import { getRebuildAdvice } from "@/lib/rag/rebuild-advice";

export const dynamic = "force-dynamic";

/**
 * GET /api/rag/rebuild-advice
 * Whether a full chat-chunk rebuild is recommended, and the reasons why.
 * Read on mount by the nav sidebar (amber dot) and the /rag page (banner).
 */
export async function GET() {
  const advice = await getRebuildAdvice();
  return NextResponse.json(advice);
}
