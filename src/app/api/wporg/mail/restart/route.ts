import { NextResponse } from "next/server";
import { getEnv } from "@/env";
import {
  getMailListenerStatus,
  restartMailListener,
} from "@/lib/wporg/mail-listener";

export const dynamic = "force-dynamic";

/**
 * POST /api/wporg/mail/restart
 * Tear down the wp.org email-push IMAP connection and reconnect — a manual
 * recovery for a wedged/stuck connection (e.g. after network changes) without
 * restarting the whole server.
 *
 * NOTE: this only re-establishes the connection using the env already loaded in
 * this process. Changing WPORG_MAIL_* values (host, credentials, enabling the
 * listener) still requires a real Next.js server restart to take effect.
 */
export async function POST() {
  // Surface a clear message when the feature isn't enabled at all — a restart
  // can't help until the env is set and the server restarted.
  if (!getEnv().WPORG_MAIL_ENABLED) {
    return NextResponse.json(
      {
        error:
          "Mail listener is disabled (set WPORG_MAIL_ENABLED + credentials and restart the server)",
        status: getMailListenerStatus(),
      },
      { status: 409 }
    );
  }
  await restartMailListener();
  return NextResponse.json({ restarted: true, status: getMailListenerStatus() });
}
