import { NextResponse } from "next/server";
import {
  getMailListenerStatus,
  readMailCursor,
} from "@/lib/wporg/mail-listener";

export const dynamic = "force-dynamic";

/**
 * GET /api/wporg/mail/status
 * The wp.org email-push listener's live state (status, lastError, lastEventAt,
 * eventsProcessed, connectedAt) plus the persisted UID cursor. The /suggestions
 * status line polls this alongside the forum-check status.
 */
export async function GET() {
  const status = getMailListenerStatus();
  const cursor = await readMailCursor();
  return NextResponse.json({ ...status, cursor });
}
