import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { CrispApiError } from "@/lib/crisp/client";
import { brandCredentials, crispClientForTarget } from "@/lib/sync/sync-service";

export const dynamic = "force-dynamic";

/**
 * POST /api/brands/:id/test
 * Verifies the brand's Crisp token (or the env fallback) can reach its
 * website by requesting the first page of conversations. Returns ok + a
 * small sample count, or the Crisp error so the operator can fix the token.
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

  const creds = brandCredentials(brand);
  const usingEnvFallback = !creds.identifier || !creds.key;

  let client;
  try {
    client = crispClientForTarget({
      brandId: brand.id,
      websiteId: brand.crispWebsiteId,
      name: brand.name,
      identifier: creds.identifier,
      key: creds.key,
    });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      usingEnvFallback,
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
      usingEnvFallback,
      sampleCount: conversations.length,
    });
  } catch (error) {
    if (error instanceof CrispApiError) {
      return NextResponse.json({
        ok: false,
        usingEnvFallback,
        status: error.status,
        error:
          error.status === 401 || error.status === 403
            ? "Crisp rejected the token — check the identifier/key and that this website is trusted for the token."
            : error.message,
      });
    }
    return NextResponse.json({
      ok: false,
      usingEnvFallback,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
