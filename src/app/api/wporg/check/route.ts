import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getCheckProgress, isCheckRunning } from "@/lib/wporg/check-state";
import { checkPluginForums } from "@/lib/wporg/watcher";

export const dynamic = "force-dynamic";
// Feed checks + LLM drafts can take a while with many plugins.
export const maxDuration = 300;

const bodySchema = z
  .object({
    withSuggestions: z.boolean().default(true),
    pluginId: z.string().optional(),
    // Resume: 1-based (alphabetical) plugin index to continue from.
    startIndex: z.coerce.number().int().min(1).optional(),
  })
  .default({ withSuggestions: true });

/**
 * POST /api/wporg/check
 * Body: { withSuggestions?: boolean, pluginId?: string }
 *
 * Kicks off a background forum check in this server process and returns
 * immediately with the initial progress. The run polls its own feeds, stores
 * new topics, drafts suggestions, and records a ForumCheckLog — the UI tracks
 * it via GET /api/wporg/check/status. `202` on start, `409` if one is running.
 * For scheduled checks, prefer the CLI (`npm run wporg:check`).
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

  if (isCheckRunning()) {
    return NextResponse.json(
      { error: "A forum check is already running", progress: getCheckProgress() },
      { status: 409 }
    );
  }

  // Fire-and-forget: checkPluginForums claims the guard synchronously (before
  // its first await) and drives ForumCheckLog + in-memory progress itself.
  // The response carries whatever state exists right now; the client's next
  // poll picks up the populated counters.
  const run = checkPluginForums(parsed.data);
  run.catch((error) => console.error("Background forum check failed:", error));

  return NextResponse.json(
    { started: true, progress: getCheckProgress() },
    { status: 202 }
  );
}
