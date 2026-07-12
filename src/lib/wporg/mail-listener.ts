import { Prisma } from "@prisma/client";
import {
  ImapFlow,
  type FetchMessageObject,
  type ImapFlowOptions,
} from "imapflow";

import { getEnv, mailListenerConfigured } from "@/env";
import { prisma } from "@/lib/db";
import { fetchHtml } from "@/lib/docs/crawler";
import { generateSuggestionForThread } from "@/lib/suggest/suggester";
import { extractPluginSlug } from "@/lib/wporg/forum-crawler";
import { extractEmailBodies, parseNotificationEmail } from "@/lib/wporg/mail-parse";
import { checkSingleTopic } from "@/lib/wporg/watcher";

/**
 * Near-realtime wp.org forum updates over IMAP email push.
 *
 * wordpress.org has no webhooks, but it emails a subscribed account on every
 * new topic and reply. A dedicated Gmail inbox collects those forwarded
 * "WordPress.org Forums" notifications; this listener watches the inbox over
 * IMAP IDLE and, within seconds of a notification, runs a targeted
 * {@link checkSingleTopic} for exactly that topic — so the RSS cron
 * (`npm run wporg:check`) can be relaxed while updates still land fast. The
 * cron remains the safety net for anything the mail path misses.
 *
 * The mailbox is opened STRICTLY read-only (`{ readOnly: true }`): the listener
 * never marks messages seen, never moves or deletes them. Progress is tracked
 * purely by UID in the `wporg_mail_cursor` AppMeta row — never by \Seen flags —
 * so the inbox is left byte-for-byte untouched.
 *
 * Lifecycle: started from Next's instrumentation `register()` hook via the
 * idempotent {@link ensureMailListener}; survives dev HMR through a globalThis
 * singleton (same idiom as sync-state.ts / check-state.ts).
 */

/** Public status of the listener, surfaced by GET /api/wporg/mail/status. */
export type MailListenerStatus =
  | "disabled"
  | "connecting"
  | "listening"
  | "error"
  | "stopped";

/** AppMeta key for the UID cursor (never a schema change; see README §NO migration). */
const CURSOR_KEY = "wporg_mail_cursor";

/** IDLE renewal cadence — Gmail drops idle connections around 29 min. */
const IDLE_RENEW_MS = 20 * 60 * 1000;
/** Reconnect backoff: 5s → 10s → 20s → … capped at 5 min. */
const RECONNECT_BASE_MS = 5_000;
const RECONNECT_MAX_MS = 5 * 60 * 1000;
/** Timeout for the fallback topic-page fetch used to resolve a plugin. */
const RESOLVE_FETCH_TIMEOUT_MS = 15_000;

/** Factory for the IMAP client — injectable so tests can drive a mock. */
export type ClientFactory = (options: ImapFlowOptions) => ImapFlow;

const defaultClientFactory: ClientFactory = (options) => new ImapFlow(options);

/**
 * UID cursor persisted in AppMeta. `lastUid` is the highest UID we have
 * processed; `updatedAt` is bookkeeping. `uidValidity` is an extra guard beyond
 * the {lastUid, updatedAt} spec: if Gmail ever reassigns UIDs (UIDVALIDITY
 * changes) a stale lastUid would point at unrelated messages, so we detect the
 * change and reset the cursor to the mailbox head instead of replaying history.
 */
interface MailCursor {
  lastUid: number;
  /** Mailbox UIDVALIDITY as a string ("" when unknown). */
  uidValidity: string;
  updatedAt: string;
}

interface MailListenerState {
  // ── Public status (mirrored into the status route) ──
  status: MailListenerStatus;
  lastError: string | null;
  /** ISO time of the last mail event that produced a topic check. */
  lastEventAt: string | null;
  /** Count of wp.org notifications turned into a topic check. */
  eventsProcessed: number;
  /** Count of new customer-last topics auto-drafted (see {@link processMessage}). */
  drafted: number;
  connectedAt: string | null;
  // ── Internal machinery ──
  client: ImapFlow | null;
  /** True while a deliberate stop is in progress — suppresses auto-reconnect. */
  stopping: boolean;
  /** Guards ensureMailListener re-entry during the async connect(). */
  starting: boolean;
  reconnectAttempt: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  /** Current mailbox UIDVALIDITY ("" when unknown). */
  uidValidity: string;
  /** Single-flight promise chain: mail events never process concurrently. */
  processing: Promise<void>;
  clientFactory: ClientFactory;
}

function freshState(): MailListenerState {
  return {
    status: "disabled",
    lastError: null,
    lastEventAt: null,
    eventsProcessed: 0,
    drafted: 0,
    connectedAt: null,
    client: null,
    stopping: false,
    starting: false,
    reconnectAttempt: 0,
    reconnectTimer: null,
    uidValidity: "",
    processing: Promise.resolve(),
    clientFactory: defaultClientFactory,
  };
}

const globalForMail = globalThis as unknown as {
  wporgMailListener?: MailListenerState;
};

function getState(): MailListenerState {
  globalForMail.wporgMailListener ??= freshState();
  return globalForMail.wporgMailListener;
}

/** Public status snapshot for GET /api/wporg/mail/status. */
export interface MailListenerStatusView {
  status: MailListenerStatus;
  lastError: string | null;
  lastEventAt: string | null;
  eventsProcessed: number;
  drafted: number;
  connectedAt: string | null;
}

export function getMailListenerStatus(): MailListenerStatusView {
  const s = getState();
  // If configuration disables the listener, always report "disabled" — a stale
  // connection object could otherwise linger after env changed (which needs a
  // restart to apply anyway).
  const status: MailListenerStatus = mailListenerConfigured()
    ? s.status
    : "disabled";
  return {
    status,
    lastError: s.lastError,
    lastEventAt: s.lastEventAt,
    eventsProcessed: s.eventsProcessed,
    drafted: s.drafted,
    connectedAt: s.connectedAt,
  };
}

// ── Cursor persistence (AppMeta) ────────────────────────────────────────────

function parseCursor(value: unknown): MailCursor | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.lastUid !== "number") return null;
  return {
    lastUid: v.lastUid,
    uidValidity: typeof v.uidValidity === "string" ? v.uidValidity : "",
    updatedAt:
      typeof v.updatedAt === "string" ? v.updatedAt : new Date().toISOString(),
  };
}

async function readCursor(): Promise<MailCursor | null> {
  const row = await prisma.appMeta.findUnique({ where: { key: CURSOR_KEY } });
  return parseCursor(row?.value);
}

/** Public read for the status route. */
export async function readMailCursor(): Promise<MailCursor | null> {
  return readCursor();
}

async function writeCursor(lastUid: number): Promise<void> {
  const cursor: MailCursor = {
    lastUid,
    uidValidity: getState().uidValidity,
    updatedAt: new Date().toISOString(),
  };
  const value = cursor as unknown as Prisma.InputJsonValue;
  await prisma.appMeta.upsert({
    where: { key: CURSOR_KEY },
    create: { key: CURSOR_KEY, value },
    update: { value },
  });
}

// ── Plugin resolution ───────────────────────────────────────────────────────

/**
 * Resolve which plugin a notification is about. First the subject's bracket
 * hint ("[Plugin Name] …") against Plugin.name / wpOrgSlug (case-insensitive);
 * failing that, fetch the topic page and read the plugin slug from its
 * `/support/plugin/<slug>/` link. Returns null when nothing matches — the
 * caller logs and skips rather than guessing.
 */
async function resolvePluginId(
  hint: string | null,
  topicUrl: string
): Promise<string | null> {
  if (hint) {
    const byHint = await prisma.plugin.findFirst({
      where: {
        wpOrgSlug: { not: null },
        OR: [
          { name: { equals: hint, mode: "insensitive" } },
          { wpOrgSlug: { equals: hint, mode: "insensitive" } },
        ],
      },
      select: { id: true },
    });
    if (byHint) return byHint.id;
  }

  // Fallback: the topic page always links back to its plugin support forum.
  const html = await fetchHtml(topicUrl, RESOLVE_FETCH_TIMEOUT_MS);
  if (html) {
    const slug = extractPluginSlug(html);
    if (slug) {
      const bySlug = await prisma.plugin.findFirst({
        where: { wpOrgSlug: { equals: slug, mode: "insensitive" } },
        select: { id: true },
      });
      if (bySlug) return bySlug.id;
    }
  }
  return null;
}

// ── Message processing ──────────────────────────────────────────────────────

/** Sender's envelope address must be on wordpress.org (display names untrusted). */
function isWpOrgSender(address: string | undefined): boolean {
  return /@wordpress\.org$/i.test((address ?? "").trim());
}

/**
 * Process one fetched message. Non-matching mail (not from @wordpress.org, or
 * with no recognizable topic link, or an unresolvable plugin) is a no-op — the
 * caller still advances the cursor past it.
 */
async function processMessage(msg: FetchMessageObject): Promise<void> {
  const from = msg.envelope?.from?.[0]?.address;
  // MATCHING: trust the envelope From address, never the display name.
  if (!isWpOrgSender(from)) return;

  const raw = msg.source ? msg.source.toString("utf8") : "";
  const bodies = extractEmailBodies(raw);
  const subject = msg.envelope?.subject ?? bodies.subject ?? "";
  const parsed = parseNotificationEmail({
    subject,
    text: bodies.text,
    html: bodies.html,
  });
  if (!parsed) {
    console.warn(`[wporg-mail] unrecognized wp.org mail (subject: ${subject})`);
    return;
  }

  const pluginId = await resolvePluginId(parsed.pluginHint, parsed.topicUrl);
  if (!pluginId) {
    console.warn(
      `[wporg-mail] unresolved plugin for ${parsed.topicUrl}` +
        ` (hint: ${parsed.pluginHint ?? "none"}) — skipping`
    );
    return;
  }

  const result = await checkSingleTopic(pluginId, parsed.topicUrl);
  const state = getState();
  state.eventsProcessed += 1;
  state.lastEventAt = new Date().toISOString();
  console.log(`[wporg-mail] ${parsed.topicUrl} → ${result.outcome}`);

  // Auto-draft ONLY a freshly created CUSTOMER-LAST topic — a brand-new
  // question where the ball is with the team. Never for "flagged" (a reply on
  // an already-tracked topic: the manual whole-thread Regenerate is the
  // intended tool there), "support_recorded", or a support-last "created" row
  // (the mail path merely tracked it into its waiting state). Same cheap
  // first-reply-only pass the feed watcher uses for its newly found topics —
  // never the expensive whole-thread follow-up pass.
  if (result.outcome === "created" && result.customerLast && result.threadId) {
    try {
      const suggestion = await generateSuggestionForThread(result.threadId);
      if (suggestion.draftAnswer) {
        state.drafted += 1;
      }
    } catch (error) {
      // Failure-isolated exactly like the per-message handling around this
      // call: log and move on. A draft failure (LLM down, no provider key,
      // RAG error) must never crash the single-flight chain, trip a
      // reconnect, flip listener status to "error", or block the UID cursor
      // from advancing past this message.
      console.error(
        `[wporg-mail] auto-draft failed for ${parsed.topicUrl}:`,
        error instanceof Error ? error.message : error
      );
    }
  }
}

/**
 * Fetch and process every message with a UID greater than the stored cursor,
 * advancing the cursor after each. Shared by the connect-time catch-up pass and
 * every IDLE `exists` event. A per-message try/catch keeps one bad email from
 * stalling the cursor behind it.
 */
async function processNewMessages(client: ImapFlow): Promise<void> {
  const cursor = await readCursor();
  const lastUid = cursor?.lastUid ?? 0;
  let maxUid = lastUid;

  // Fetch UIDs strictly above the cursor. NOTE the IMAP quirk: when
  // `lastUid+1` is past the last UID, the server clamps `*` and still returns
  // the final message — the `msg.uid <= lastUid` guard drops that duplicate.
  for await (const msg of client.fetch(
    `${lastUid + 1}:*`,
    { uid: true, envelope: true, source: true },
    { uid: true }
  )) {
    if (msg.uid <= lastUid) continue;
    try {
      await processMessage(msg);
    } catch (error) {
      console.error(
        `[wporg-mail] failed to process UID ${msg.uid}:`,
        error instanceof Error ? error.message : error
      );
    }
    // Advance past this message whether or not it matched — a non-matching or
    // failed message must never be retried forever.
    maxUid = Math.max(maxUid, msg.uid);
    await writeCursor(maxUid);
  }
}

/**
 * Queue a processing pass onto the single-flight chain so two `exists` events
 * (or an event during the catch-up pass) never run concurrently. A mail event
 * arriving DURING a running full forum check is fine and not gated — both paths
 * are idempotent upserts on the same rows.
 */
function enqueueProcess(client: ImapFlow): void {
  const state = getState();
  state.processing = state.processing
    .catch(() => {})
    .then(async () => {
      // Ignore stale clients (a reconnect replaced this one) or a dead socket.
      if (state.client !== client || !client.usable) return;
      await processNewMessages(client);
    })
    .catch((error) => {
      console.error("[wporg-mail] processing pass failed:", error);
    });
}

// ── Connection lifecycle ────────────────────────────────────────────────────

function scheduleReconnect(): void {
  const state = getState();
  if (state.stopping || state.reconnectTimer !== null) return;
  const delay = Math.min(
    RECONNECT_BASE_MS * 2 ** state.reconnectAttempt,
    RECONNECT_MAX_MS
  );
  state.reconnectAttempt += 1;
  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;
    void connect();
  }, delay);
  // Never keep the process alive just for a pending reconnect.
  state.reconnectTimer.unref?.();
}

function handleConnectionError(error: unknown): void {
  const state = getState();
  state.lastError = error instanceof Error ? error.message : String(error);
  if (state.stopping) return;
  state.status = "error";
  scheduleReconnect();
}

function handleClose(): void {
  const state = getState();
  if (state.stopping) {
    state.status = "stopped";
    return;
  }
  // Unexpected drop (e.g. Gmail closing an idle socket) — reconnect.
  state.status = "error";
  scheduleReconnect();
}

/**
 * On first ever run (or after a UIDVALIDITY change) point the cursor at the
 * mailbox head so we start listening from NOW rather than replaying the entire
 * inbox history — which would fan out into hundreds of topic checks. Real
 * catch-up (mail that arrived while we were down) is driven by a persisted
 * cursor from a previous run.
 */
async function bootstrapCursor(mailbox: {
  uidNext?: number;
  uidValidity?: bigint;
}): Promise<void> {
  const state = getState();
  const uidValidity =
    mailbox.uidValidity != null ? String(mailbox.uidValidity) : "";
  state.uidValidity = uidValidity;

  const cursor = await readCursor();
  const validityChanged = Boolean(
    cursor && cursor.uidValidity && uidValidity && cursor.uidValidity !== uidValidity
  );
  if (!cursor || validityChanged) {
    const head = Math.max((mailbox.uidNext ?? 1) - 1, 0);
    await writeCursor(head);
    if (validityChanged) {
      console.warn("[wporg-mail] UIDVALIDITY changed — cursor reset to head");
    }
  }
}

async function connect(): Promise<void> {
  const state = getState();
  state.starting = true;
  state.stopping = false;
  state.status = "connecting";
  const env = getEnv();

  // Abandon any previous client cleanly so its late 'close'/'error' events
  // can't fire handlers into this fresh connection.
  const previous = state.client;
  if (previous) {
    try {
      previous.removeAllListeners();
    } catch {
      // ignore
    }
    try {
      previous.close();
    } catch {
      // ignore
    }
    state.client = null;
  }

  let client: ImapFlow;
  try {
    client = state.clientFactory({
      host: env.WPORG_MAIL_HOST,
      port: env.WPORG_MAIL_PORT,
      secure: true,
      auth: {
        user: env.WPORG_MAIL_USER ?? "",
        pass: env.WPORG_MAIL_PASSWORD ?? "",
      },
      logger: false,
      // imapflow auto-idles when the connection is free and emits 'exists';
      // maxIdleTime breaks+restarts IDLE well before Gmail's ~29-min drop.
      maxIdleTime: IDLE_RENEW_MS,
    });
  } catch (error) {
    state.starting = false;
    handleConnectionError(error);
    return;
  }

  state.client = client;
  // Wire handlers before connecting so no early 'exists'/'error' is missed.
  client.on("error", handleConnectionError);
  client.on("close", handleClose);
  client.on("exists", () => enqueueProcess(client));

  try {
    await client.connect();
    const mailbox = await client.mailboxOpen("INBOX", { readOnly: true });
    await bootstrapCursor(mailbox);
    state.status = "listening";
    state.connectedAt = new Date().toISOString();
    state.reconnectAttempt = 0;
    state.lastError = null;
    // Catch-up: process anything that arrived while we were disconnected.
    enqueueProcess(client);
  } catch (error) {
    handleConnectionError(error);
  } finally {
    state.starting = false;
  }
}

/**
 * Start the listener if configured and not already running. Idempotent:
 * repeated calls no-op while a connection is live, connecting, or a reconnect
 * is pending. Refuses to start unless WPORG_MAIL_ENABLED and both USER and
 * PASSWORD are set. Optionally inject a client factory (tests only).
 */
export function ensureMailListener(options?: {
  clientFactory?: ClientFactory;
}): void {
  const state = getState();
  if (options?.clientFactory) state.clientFactory = options.clientFactory;

  if (!mailListenerConfigured()) {
    state.status = "disabled";
    return;
  }
  if (
    state.status === "connecting" ||
    state.status === "listening" ||
    state.starting ||
    state.reconnectTimer !== null
  ) {
    return;
  }
  void connect();
}

/** Tear down the connection and cancel any pending reconnect. */
export async function stopMailListener(): Promise<void> {
  const state = getState();
  state.stopping = true;
  if (state.reconnectTimer !== null) {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }
  const client = state.client;
  state.client = null;
  state.status = "stopped";
  state.connectedAt = null;
  if (client) {
    try {
      await client.logout();
    } catch {
      try {
        client.close();
      } catch {
        // Already gone.
      }
    }
  }
}

/**
 * Tear down and reconnect. Exposed for POST /api/wporg/mail/restart to recover
 * a wedged connection WITHOUT a full server restart. NOTE: this reuses the
 * already-loaded process env — a genuine Next restart is still required to pick
 * up changed WPORG_MAIL_* values.
 */
export async function restartMailListener(): Promise<void> {
  await stopMailListener();
  const state = getState();
  state.stopping = false;
  state.reconnectAttempt = 0;
  state.status = "disabled";
  ensureMailListener();
}
