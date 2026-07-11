import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { canonicalForumUrl, isWpOrgForumUrl } from "@/lib/wporg/forum-crawler";

export const dynamic = "force-dynamic";

const createSchema = z.object({
  pluginId: z.string().min(1),
  url: z.string().url("A valid http(s) URL is required"),
  type: z.enum(["url", "sitemap", "wporg_forum"]).default("url"),
});

/** POST /api/docs/sources — register a docs source for a plugin. */
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

  const { pluginId } = parsed.data;
  if (!/^https?:$/.test(new URL(parsed.data.url).protocol)) {
    return NextResponse.json(
      { error: "Only http(s) URLs are supported" },
      { status: 400 }
    );
  }
  // A wp.org support-forum URL is always a forum source, whatever type the
  // form submitted — the plain crawler would only see the listing chrome.
  // Forum URLs are canonicalized (https, no www, trailing slash) so scoping
  // and de-dup are consistent.
  const isForum = isWpOrgForumUrl(parsed.data.url) || parsed.data.type === "wporg_forum";
  const type = isForum ? "wporg_forum" : parsed.data.type;
  const url = isForum ? canonicalForumUrl(parsed.data.url) : parsed.data.url;

  // One forum Q&A source per plugin — return the existing one instead of
  // creating a duplicate (covers double-clicks and legacy "url"-typed rows).
  if (isForum) {
    const existing = await prisma.docsSource.findFirst({
      where: { pluginId, OR: [{ type: "wporg_forum" }, { url }] },
    });
    if (existing) {
      return NextResponse.json({ source: existing, existing: true }, { status: 200 });
    }
  }

  try {
    const source = await prisma.docsSource.create({
      data: { pluginId, url, type },
    });
    return NextResponse.json({ source }, { status: 201 });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2003"
    ) {
      return NextResponse.json({ error: "Plugin not found" }, { status: 404 });
    }
    throw error;
  }
}
