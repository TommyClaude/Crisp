import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { invalidateProductDefinitions } from "@/lib/rag/product-defs";
import { touchProductDefsChanged } from "@/lib/rag/rebuild-advice";
import { forumUrlForSlug } from "@/lib/wporg/forum-crawler";

export const dynamic = "force-dynamic";

function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

/** GET /api/plugins — plugins with brand + docs sources. */
export async function GET() {
  const plugins = await prisma.plugin.findMany({
    orderBy: [{ brand: { name: "asc" } }, { name: "asc" }],
    include: {
      brand: { select: { id: true, name: true } },
      docsSources: { orderBy: { createdAt: "asc" } },
      _count: { select: { chunks: true } },
    },
  });
  return NextResponse.json({ plugins });
}

/**
 * Comma-separated keywords, normalized server-side (never trust the client
 * alone): trimmed, empties dropped, case-insensitive duplicates collapsed
 * (first-seen casing kept). Keyword changes alter product-detection rules,
 * so callers must also touch product-defs-changed — see POST/PATCH below.
 */
const detectionKeywordsSchema = z
  .array(z.string().max(100))
  .max(50)
  .transform((keywords) => {
    const seen = new Set<string>();
    const deduped: string[] = [];
    for (const raw of keywords) {
      const trimmed = raw.trim();
      if (!trimmed) continue;
      const key = trimmed.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(trimmed);
    }
    return deduped;
  });

const createSchema = z.object({
  brandId: z.string().min(1),
  name: z.string().min(1).max(100),
  wpOrgSlug: z.string().max(200).optional(),
  detectionKeywords: detectionKeywordsSchema.default([]),
});

/** POST /api/plugins — create a plugin under a brand. */
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

  const { brandId, name, wpOrgSlug, detectionKeywords } = parsed.data;
  try {
    const plugin = await prisma.plugin.create({
      data: {
        brandId,
        name: name.trim(),
        slug: slugify(name),
        wpOrgSlug: wpOrgSlug?.trim() || null,
        detectionKeywords,
      },
      include: { brand: { select: { id: true, name: true } } },
    });
    // A wp.org slug implies a support forum — register it as a Q&A source
    // right away so "Ingest" is one click on the Plugins page.
    if (plugin.wpOrgSlug) {
      await prisma.docsSource.create({
        data: {
          pluginId: plugin.id,
          url: forumUrlForSlug(plugin.wpOrgSlug),
          type: "wporg_forum",
        },
      });
    }
    invalidateProductDefinitions();
    await touchProductDefsChanged();
    return NextResponse.json({ plugin }, { status: 201 });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === "P2002") {
        return NextResponse.json(
          { error: "A plugin with this name already exists" },
          { status: 409 }
        );
      }
      if (error.code === "P2003") {
        return NextResponse.json({ error: "Brand not found" }, { status: 404 });
      }
    }
    throw error;
  }
}
