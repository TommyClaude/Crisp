import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { CrispApiError } from "@/lib/crisp/client";
import { crispClientForTarget } from "@/lib/sync/sync-service";

export const dynamic = "force-dynamic";

/**
 * POST /api/brands/:id/test
 * Verifies the global Crisp token (CRISP_IDENTIFIER/CRISP_KEY in .env) can
 * reach this brand's website by requesting the first page of conversations.
 * Returns ok + a small sample count, or the Crisp error so the operator can
 * diagnose it (e.g. the Marketplace plugin isn't installed on this
 * workspace).
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const brand = await prisma.brand.findUnique({ where: { id } });
  if (!brand) {
    return NextResponse.json({ error: "Brand not found" }, { status: 404 });
  }

  let client;
  try {
    client = crispClientForTarget();
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    const conversations = await client.listConversations(
      brand.crispWebsiteId,
      1
    );
    return NextResponse.json({
      ok: true,
      sampleCount: conversations.length,
    });
  } catch (error) {
    if (error instanceof CrispApiError) {
      return NextResponse.json({
        ok: false,
        status: error.status,
        error:
          error.status === 401 || error.status === 403
            ? "Crisp rejected the token — check CRISP_IDENTIFIER/CRISP_KEY in .env and that the Marketplace plugin is installed on this brand's workspace."
            : error.message,
      });
    }
    return NextResponse.json({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
