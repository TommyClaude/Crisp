import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

const createSchema = z.object({
  pluginId: z.string().min(1),
  url: z.string().url("A valid http(s) URL is required"),
  type: z.enum(["url", "sitemap"]).default("url"),
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

  const { pluginId, url, type } = parsed.data;
  if (!/^https?:$/.test(new URL(url).protocol)) {
    return NextResponse.json(
      { error: "Only http(s) URLs are supported" },
      { status: 400 }
    );
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
