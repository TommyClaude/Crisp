import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getCheckProgress, requestCheckCancel } from "@/lib/wporg/check-state";

export const dynamic = "force-dynamic";

const bodySchema = z
  .object({
    // Pause records the run as "paused" (resumable via "Continue"); Stop
    // records it as "cancelled". Both halt between plugins.
    pause: z.boolean().default(false),
  })
  .default({ pause: false });

/**
 * POST /api/wporg/check/stop
 * Body: { pause?: boolean }
 *
 * Requests a graceful halt of the running forum check. The run finishes the
 * plugin in flight, skips drafting, and marks the ForumCheckLog "paused"
 * (pause) or "cancelled" (stop) with the plugin index reached — from which it
 * can be continued. `409` when nothing is running.
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

  const reason = parsed.data.pause ? "paused" : "cancelled";
  const requested = requestCheckCancel(reason);
  if (!requested) {
    return NextResponse.json(
      { error: "No forum check is currently running" },
      { status: 409 }
    );
  }
  return NextResponse.json({
    stopping: true,
    reason,
    progress: getCheckProgress(),
  });
}
