import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { checkPluginForums, isWatcherRunning } from "@/lib/wporg/watcher";

export const dynamic = "force-dynamic";
// Feed checks + LLM drafts can take a while with many plugins.
export const maxDuration = 300;

const bodySchema = z
  .object({
    withSuggestions: z.boolean().default(true),
    pluginId: z.string().optional(),
  })
  .default({ withSuggestions: true });

/**
 * POST /api/wporg/check
 * Body: { withSuggestions?: boolean, pluginId?: string }
 * Polls the wp.org support-forum feeds of all plugins with a wpOrgSlug,
 * stores new threads, and drafts reply suggestions. Returns the counts.
 */
export async function POST(request: NextRequest) {
  let json: unknown = {};
  try {
    const text = await request.text();
    json = text ? JSON.parse(text) : {};
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request", issues: parsed.error.issues },
      { status: 400 }
    );
  }

  if (isWatcherRunning()) {
    return NextResponse.json(
      { error: "A forum check is already running" },
      { status: 409 }
    );
  }

  try {
    const result = await checkPluginForums(parsed.data);
    return NextResponse.json(result);
  } catch (error) {
    console.error("Forum check failed:", error);
    return NextResponse.json(
      { error: "Forum check failed", detail: String(error) },
      { status: 500 }
    );
  }
}
