import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { invalidateProductDefinitions } from "@/lib/rag/product-defs";
import { touchProductDefsChanged } from "@/lib/rag/rebuild-advice";
import { forumUrlForSlug } from "@/lib/wporg/forum-crawler";

export const dynamic = "force-dynamic";

/**
 * Comma-separated keywords, normalized server-side (never trust the client
 * alone): trimmed, empties dropped, case-insensitive duplicates collapsed
 * (first-seen casing kept). Keyword changes alter product-detection rules —
 * this route always touches product-defs-changed below so the "Rebuild
 * recommended" staleness banner arms.
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

const patchSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  wpOrgSlug: z.string().max(200).nullable().optional(),
  detectionKeywords: detectionKeywordsSchema.optional(),
});

/** PATCH /api/plugins/:id — update name/keywords/wp.org slug. */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = patchSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request", issues: parsed.error.issues },
      { status: 400 }
    );
  }

  try {
    const plugin = await prisma.plugin.update({
      where: { id },
      data: {
        ...(parsed.data.name !== undefined
          ? { name: parsed.data.name.trim() }
          : {}),
        ...(parsed.data.wpOrgSlug !== undefined
          ? { wpOrgSlug: parsed.data.wpOrgSlug?.trim() || null }
          : {}),
        ...(parsed.data.detectionKeywords !== undefined
          ? { detectionKeywords: parsed.data.detectionKeywords }
          : {}),
      },
    });
    // A wp.org slug implies a support forum. Register / repoint the plugin's
    // forum Q&A source when the slug is set or changed.
    if (plugin.wpOrgSlug && parsed.data.wpOrgSlug !== undefined) {
      const forumUrl = forumUrlForSlug(plugin.wpOrgSlug);
      // Match by type OR forum URL so a legacy "url"-typed forum source counts
      // as the existing one (and isn't duplicated).
      const existing = await prisma.docsSource.findFirst({
        where: {
          pluginId: plugin.id,
          OR: [{ type: "wporg_forum" }, { url: forumUrl }],
        },
        select: { id: true, url: true },
      });
      if (!existing) {
        await prisma.docsSource.create({
          data: { pluginId: plugin.id, url: forumUrl, type: "wporg_forum" },
        });
      } else if (existing.url !== forumUrl) {
        // Slug changed — repoint at the new forum and drop the old slug's
        // ingested threads so they don't linger under the wrong product.
        await prisma.$transaction([
          prisma.docsPage.deleteMany({ where: { docsSourceId: existing.id } }),
          prisma.docsSource.update({
            where: { id: existing.id },
            data: {
              url: forumUrl,
              type: "wporg_forum",
              status: "idle",
              pageCount: 0,
              chunkCount: 0,
              lastCrawledAt: null,
              error: null,
            },
          }),
        ]);
      }
    }
    invalidateProductDefinitions();
    await touchProductDefsChanged();
    return NextResponse.json({ plugin });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === "P2025") {
        return NextResponse.json({ error: "Plugin not found" }, { status: 404 });
      }
      if (error.code === "P2002") {
        return NextResponse.json(
          { error: "A plugin with this name already exists" },
          { status: 409 }
        );
      }
    }
    throw error;
  }
}

/** DELETE /api/plugins/:id — removes the plugin, its docs and doc chunks. */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    await prisma.plugin.delete({ where: { id } });
    invalidateProductDefinitions();
    await touchProductDefsChanged();
    return NextResponse.json({ deleted: true });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2025"
    ) {
      return NextResponse.json({ error: "Plugin not found" }, { status: 404 });
    }
    throw error;
  }
}
