import type { Prisma } from "@prisma/client";

import { getEnv } from "@/env";
import { prisma } from "@/lib/db";
import {
  escapeMrkdwn,
  postSlackBlocks,
  slackConfigured,
  TITLE_CAP,
  truncate,
  type SlackPayload,
} from "@/lib/notify/slack";
import { daysSinceWaiting, silenceNudgeCutoff } from "@/lib/suggest/promise";
import { needsResolvedWhere } from "@/lib/suggest/suggestions-view";

/**
 * Roughly-daily Slack digest of "Needs resolved" topics (owner-approved
 * design: "timing does not need to be precise, checking every 12h is fine").
 *
 * wp.org topics the support team already answered, with the customer silent
 * past WPORG_SILENCE_NUDGE_DAYS, sit in the /suggestions "Needs resolved" tab
 * with a ready gentle-close draft — but nobody is nudged to go look. This
 * module periodically checks that SAME set (via {@link needsResolvedWhere},
 * reused verbatim from suggestions-view.ts — never duplicated) and, when it's
 * non-empty and it has been "long enough" since the last digest, posts one
 * Slack message summarizing it.
 *
 * Lifecycle: started from Next's instrumentation `register()` hook via the
 * idempotent {@link ensureNeedsResolvedDigest}; survives dev HMR through a
 * globalThis singleton (same idiom as mail-listener.ts / sync-state.ts).
 * Started independently of the wp.org mail listener — it only needs Slack +
 * DB, not WPORG_MAIL_*.
 *
 * Entirely failure-isolated: any DB or Slack error is caught, logged (tagged
 * "[slack-digest]"), and never thrown out of the interval callback.
 */

/** AppMeta key for the "last digest sent" stamp (never a schema change — see
 *  README §NO migration, same idiom as wporg_mail_cursor). */
const DIGEST_STAMP_KEY = "slack_digest_last";

/** Check cadence — imprecise by design; see the module doc comment. */
const CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;

/** Minimum gap since the last successful digest before another one is sent.
 *  Deliberately just under 24h (rather than exactly 24h) so a check running a
 *  little early/late on the 12h cadence still lands roughly once a day
 *  instead of drifting to every-other-day. */
const MIN_GAP_MS = 22 * 60 * 60 * 1000;

/** Cap on how many topics are listed by name before collapsing into "+K more". */
const MAX_DIGEST_LINES = 15;

/** Persisted shape of the DIGEST_STAMP_KEY AppMeta row. */
interface DigestStamp {
  sentAt: string;
}

function parseStamp(value: unknown): DigestStamp | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.sentAt !== "string") return null;
  return { sentAt: v.sentAt };
}

async function readStamp(): Promise<DigestStamp | null> {
  const row = await prisma.appMeta.findUnique({
    where: { key: DIGEST_STAMP_KEY },
  });
  return parseStamp(row?.value);
}

async function writeStamp(now: Date): Promise<void> {
  const stamp: DigestStamp = { sentAt: now.toISOString() };
  const value = stamp as unknown as Prisma.InputJsonValue;
  await prisma.appMeta.upsert({
    where: { key: DIGEST_STAMP_KEY },
    create: { key: DIGEST_STAMP_KEY, value },
    update: { value },
  });
}

/** Minimal shape {@link buildNeedsResolvedDigestPayload} needs per topic. */
export interface DigestThreadRow {
  title: string;
  url: string;
  pluginName: string;
  /** Whole days the topic has been waiting on the customer (from waitingSince). */
  waitingDays: number;
}

/**
 * Build the Slack payload for the Needs-resolved digest. Pure (no network, no
 * env/DB access) so it's unit-testable without stubbing fetch. mrkdwn: a
 * header line with the total count, up to {@link MAX_DIGEST_LINES} lines
 * "• <url|title> (PluginName) — quiet for N days" (longest-waiting first —
 * callers should pass `rows` pre-sorted), a "+K more" line when truncated,
 * and a context line pointing at the Needs-resolved tab.
 */
export function buildNeedsResolvedDigestPayload(
  rows: DigestThreadRow[],
  /** True total across the whole qualifying set — the query only fetches the
   *  first {@link MAX_DIGEST_LINES} rows, so the header count and the
   *  "+K more" line come from a separate count(). Defaults to rows.length. */
  totalCount?: number
): SlackPayload {
  const count = totalCount ?? rows.length;
  const shown = rows.slice(0, MAX_DIGEST_LINES);
  const remaining = count - shown.length;

  const lines = shown.map((row) => {
    // Every user-influenced string is escaped — title AND plugin name are
    // both ultimately sourced from the wp.org forum / plugin config.
    const title = truncate(escapeMrkdwn(row.title), TITLE_CAP);
    const pluginName = escapeMrkdwn(row.pluginName);
    return `• <${row.url}|${title}> (${pluginName}) — quiet for ${row.waitingDays} days`;
  });
  if (remaining > 0) lines.push(`+${remaining} more`);

  const blocks: Record<string, unknown>[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `🔔 *${count} topics waiting on customers — consider a gentle close*`,
      },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: lines.join("\n") },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: "Each topic has a ready gentle-close draft in YayAssist → /suggestions (Needs resolved tab)",
        },
      ],
    },
  ];

  return {
    text: `${count} topics waiting on customers — consider a gentle close`,
    blocks,
  };
}

/**
 * One digest check: skip if Slack isn't configured, skip if the last
 * successful send was less than {@link MIN_GAP_MS} ago, otherwise query the
 * CURRENT Needs-resolved set (the exact where-clause the /suggestions tab
 * uses) and — only when it's non-empty — build and send one Slack message.
 * The AppMeta stamp is updated ONLY on a successful post: an empty set never
 * touches the stamp (so a quiet morning check doesn't push the next real
 * digest a full cycle later than necessary), and a failed post leaves the
 * stamp alone so the next 12h check retries rather than silently skipping
 * for another day.
 *
 * `now` is injectable (tests only) so the 22h guard and day-counts can be
 * driven without real waiting. Never throws — DB errors are caught and
 * logged here (tagged "[slack-digest]"); a failed webhook POST doesn't throw
 * at all and logs via the slack module as "[slack] digest failed: …".
 */
export async function runNeedsResolvedDigestCheck(options?: {
  now?: Date;
}): Promise<void> {
  const now = options?.now ?? new Date();
  try {
    if (!slackConfigured()) return;

    const stamp = await readStamp();
    if (stamp) {
      const last = new Date(stamp.sentAt);
      if (
        !Number.isNaN(last.getTime()) &&
        now.getTime() - last.getTime() < MIN_GAP_MS
      ) {
        return;
      }
    }

    const env = getEnv();
    const silenceCutoff = silenceNudgeCutoff(env.WPORG_SILENCE_NUDGE_DAYS, now);
    const where = needsResolvedWhere(silenceCutoff);
    // Only the rows that will actually render are fetched; the header count
    // and "+K more" line use the separate count() so a pathological backlog
    // never gets pulled wholesale into memory just to show 15 lines.
    const [total, rows] = await Promise.all([
      prisma.supportThread.count({ where }),
      prisma.supportThread.findMany({
        where,
        include: { plugin: { select: { name: true } } },
        // Longest-waiting first — same ordering as the /suggestions tab.
        orderBy: [{ waitingSince: { sort: "asc", nulls: "last" } }],
        take: MAX_DIGEST_LINES,
      }),
    ]);
    if (total === 0 || rows.length === 0) return;

    const payload = buildNeedsResolvedDigestPayload(
      rows.map((row) => ({
        title: row.title,
        url: row.url,
        pluginName: row.plugin.name,
        waitingDays: row.waitingSince
          ? daysSinceWaiting(row.waitingSince, now)
          : 0,
      })),
      total
    );

    const ok = await postSlackBlocks(payload, "digest");
    if (ok) await writeStamp(now);
  } catch (error) {
    console.error(
      "[slack-digest] check failed:",
      error instanceof Error ? error.message : error
    );
  }
}

interface DigestState {
  intervalId: ReturnType<typeof setInterval> | null;
}

const globalForDigest = globalThis as unknown as {
  needsResolvedDigest?: DigestState;
};

function getState(): DigestState {
  globalForDigest.needsResolvedDigest ??= { intervalId: null };
  return globalForDigest.needsResolvedDigest;
}

/**
 * Start the Needs-resolved digest if configured and not already running.
 * Idempotent (repeated calls no-op once the interval is set — same idiom as
 * ensureMailListener), and independent of the wp.org mail listener: it only
 * needs {@link slackConfigured} + DB access, so it starts even when
 * WPORG_MAIL_* is unset. Runs one immediate check at startup, then checks
 * every 12h on an unref'd interval (never keeps the process alive by itself).
 */
export function ensureNeedsResolvedDigest(): void {
  if (!slackConfigured()) return;
  const state = getState();
  if (state.intervalId !== null) return;

  void runNeedsResolvedDigestCheck();
  const interval = setInterval(() => {
    void runNeedsResolvedDigestCheck();
  }, CHECK_INTERVAL_MS);
  interval.unref?.();
  state.intervalId = interval;
}
