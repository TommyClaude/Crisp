import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { invalidateProductDefinitions } from "@/lib/rag/product-defs";
import { touchProductDefsChanged } from "@/lib/rag/rebuild-advice";
import { forumUrlForSlug } from "@/lib/wporg/forum-crawler";
import {
  fetchAuthorPlugins,
  shortPluginName,
} from "@/lib/wporg/author-plugins";

export const dynamic = "force-dynamic";

function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function isP2002(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  );
}

/**
 * POST /api/brands/:id/import-plugins
 *
 * Fetches every plugin published by the brand's wordpress.org author profile
 * (its `wpProfileSlug`) and creates a Plugin row — plus an idle Forum Q&A
 * DocsSource, exactly like POST /api/plugins does — for each one that doesn't
 * already exist. Nothing is ingested; the operator clicks "Ingest" per plugin
 * on /plugins. Plugins already present (by wp.org slug or by derived name) are
 * skipped, never duplicated.
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
  const profileSlug = brand.wpProfileSlug?.trim();
  if (!profileSlug) {
    return NextResponse.json(
      {
        error:
          "This brand has no wp.org profile slug — set one before importing plugins.",
      },
      { status: 400 }
    );
  }

  let authorPlugins;
  try {
    authorPlugins = await fetchAuthorPlugins(profileSlug);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 502 }
    );
  }

  // Preload existing plugins once so skip-checks (and slug de-dup) are local.
  const existing = await prisma.plugin.findMany({
    select: { name: true, slug: true, wpOrgSlug: true },
  });
  const existingWpSlugs = new Set(
    existing
      .map((p) => p.wpOrgSlug?.toLowerCase())
      .filter((s): s is string => Boolean(s))
  );
  const existingNames = new Set(existing.map((p) => p.name.toLowerCase()));
  const usedSlugs = new Set(existing.map((p) => p.slug.toLowerCase()));

  const created: Array<{ name: string; wpOrgSlug: string }> = [];
  const errors: string[] = [];
  let skipped = 0;

  for (const { slug: wpOrgSlug, name: rawName } of authorPlugins) {
    const shortName = shortPluginName(rawName);
    const wpSlugLower = wpOrgSlug.toLowerCase();

    // Skip when a plugin already exists with this wp.org slug or derived name.
    if (existingWpSlugs.has(wpSlugLower) || existingNames.has(shortName.toLowerCase())) {
      skipped += 1;
      continue;
    }

    // detectionKeywords: keep the wp.org slug as a keyword only when it adds a
    // distinct form the name doesn't already carry (spaces removed, lowered).
    const shortNameKey = shortName.toLowerCase().replace(/\s+/g, "");
    const detectionKeywords =
      wpSlugLower !== shortNameKey ? [wpOrgSlug] : [];

    // slug de-dup: derive from the short (decoded) name so slugs stay clean
    // — slugifying the raw name would bake entity digits/taglines into it —
    // and append the wp.org slug when that base slug is already taken.
    let slug = slugify(shortName) || wpOrgSlug;
    if (usedSlugs.has(slug.toLowerCase())) slug = `${slug}-${wpOrgSlug}`;

    const createPlugin = (name: string, pluginSlug: string) =>
      prisma.plugin.create({
        data: {
          brandId: brand.id,
          name,
          slug: pluginSlug,
          wpOrgSlug,
          detectionKeywords,
        },
      });

    let plugin;
    try {
      plugin = await createPlugin(shortName, slug);
    } catch (error) {
      if (!isP2002(error)) throw error;
      // A name (or slug) race with a concurrent import — retry once with a
      // disambiguated name and a guaranteed-unique slug.
      const retryName = `${shortName} (${wpOrgSlug})`;
      const retrySlug = slug.endsWith(`-${wpOrgSlug}`)
        ? slug
        : `${slug}-${wpOrgSlug}`;
      try {
        plugin = await createPlugin(retryName, retrySlug);
      } catch (retryError) {
        if (!isP2002(retryError)) throw retryError;
        skipped += 1;
        errors.push(`Could not import "${shortName}" (${wpOrgSlug}) — name or slug already in use.`);
        continue;
      }
    }

    // A wp.org slug implies a support forum — register it as an idle Q&A
    // source right away (no ingest), mirroring POST /api/plugins.
    await prisma.docsSource.create({
      data: {
        pluginId: plugin.id,
        url: forumUrlForSlug(wpOrgSlug),
        type: "wporg_forum",
      },
    });

    created.push({ name: plugin.name, wpOrgSlug });
    existingWpSlugs.add(wpSlugLower);
    existingNames.add(plugin.name.toLowerCase());
    usedSlugs.add(plugin.slug.toLowerCase());
  }

  if (created.length > 0) {
    invalidateProductDefinitions();
    await touchProductDefsChanged();
  }

  return NextResponse.json({
    imported: created.length,
    skipped,
    errors,
    plugins: created,
  });
}
