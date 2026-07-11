import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

/** GET /api/brands — brands with counts. */
export async function GET() {
  const brands = await prisma.brand.findMany({
    orderBy: { createdAt: "asc" },
    include: { _count: { select: { plugins: true, conversations: true } } },
  });
  return NextResponse.json({ brands });
}

const createSchema = z.object({
  name: z.string().min(1).max(100),
  crispWebsiteId: z.string().min(8).max(100),
  // wordpress.org author username for one-click plugin import.
  wpProfileSlug: z.string().max(100).nullable().optional(),
});

/**
 * POST /api/brands — create a brand (one per Crisp website). Every brand
 * authenticates with the global CRISP_IDENTIFIER/CRISP_KEY in .env (a Crisp
 * Marketplace plugin production token, installed on every brand's
 * workspace). Existing conversations already synced with this websiteId are
 * linked to the brand.
 */
export async function POST(request: NextRequest) {
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = createSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request", issues: parsed.error.issues },
      { status: 400 }
    );
  }

  const { name, crispWebsiteId, wpProfileSlug } = parsed.data;

  try {
    const brand = await prisma.brand.create({
      data: {
        name,
        slug: slugify(name) || crispWebsiteId.slice(0, 8),
        crispWebsiteId: crispWebsiteId.trim(),
        wpProfileSlug: wpProfileSlug?.trim() || null,
      },
    });
    // Adopt conversations that were synced before this brand existed.
    const adopted = await prisma.conversation.updateMany({
      where: { websiteId: brand.crispWebsiteId, brandId: null },
      data: { brandId: brand.id },
    });
    return NextResponse.json(
      { brand, adoptedConversations: adopted.count },
      { status: 201 }
    );
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      return NextResponse.json(
        { error: "A brand with this name or Crisp website ID already exists" },
        { status: 409 }
      );
    }
    throw error;
  }
}
