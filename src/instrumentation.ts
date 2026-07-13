/**
 * Next.js instrumentation hook — runs once when the server process boots.
 *
 * Starts the wp.org email-push listener (src/lib/wporg/mail-listener.ts) so
 * forum notifications begin driving near-realtime topic checks as soon as the
 * server is up, and the roughly-daily Slack "Needs resolved" digest
 * (src/lib/notify/digest.ts). Guarded to the Node.js runtime (the Edge runtime
 * has no TCP/TLS sockets and must never pull in imapflow/Prisma), and imported
 * dynamically so those server-only modules never load on Edge. Both starters
 * are idempotent and independently no-op when unconfigured: ensureMailListener()
 * unless WPORG_MAIL_ENABLED + USER + PASSWORD are set, ensureNeedsResolvedDigest()
 * unless SLACK_WEBHOOK_URL is set — so the digest starts even when the mail
 * listener doesn't (it only needs Slack + DB).
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { ensureMailListener } = await import("@/lib/wporg/mail-listener");
  ensureMailListener();
  const { ensureNeedsResolvedDigest } = await import("@/lib/notify/digest");
  ensureNeedsResolvedDigest();
}
