import { getEnv, slackConfigured as envSlackConfigured } from "@/env";

/**
 * Slack notifications for wp.org forum activity — pushes "new topic + ready
 * draft" (both ingestion paths) and "new customer reply + suggested follow-up"
 * (mail path only — see the feed drafting loop in watcher.ts for why replies
 * deliberately never notify there) into the support team's Slack channel via
 * an Incoming Webhook, so they see it without polling /suggestions. Entirely
 * optional and env-gated by SLACK_WEBHOOK_URL (see {@link slackConfigured} /
 * src/env.ts): silently disabled when unset.
 *
 * Deliberately free of DB/Prisma imports — callers (mail-listener.ts,
 * watcher.ts) resolve the thread/plugin fields and pass them in, so this
 * module stays a small, network-only, easily-unit-tested piece. Never throws:
 * {@link notifySlackTopic} always resolves (true/false) so a Slack outage can
 * never break the mail listener's cursor or the feed watcher's run.
 */

/** Which event the notification announces. Shapes the header line, whether
 *  the topic's original author/excerpt render, and the draft section label. */
export type SlackTopicKind = "new_topic" | "new_reply";

export interface SlackTopicNotificationInput {
  /** Defaults to "new_topic". */
  kind?: SlackTopicKind;
  pluginName: string;
  title: string;
  url: string;
  author: string | null;
  excerpt: string;
  /** SupportThread.id — used only for log tagging, never sent to Slack. */
  threadId: string;
  /**
   * Draft text to show: the first-reply draft (SupportThread.draftAnswer) for
   * "new_topic"; the whole-thread follow-up draft (first followupJson.drafts
   * entry with text) for "new_reply". null when drafting failed / was skipped
   * / no provider is configured — the message then says a draft couldn't be
   * generated yet.
   */
  draftAnswer: string | null;
}

/** Back-compat alias for the pre-`kind` input name. */
export type SlackNewTopicInput = SlackTopicNotificationInput;

/** Minimal shape of a Slack Incoming Webhook payload (mrkdwn blocks). */
export interface SlackPayload {
  text: string;
  blocks: Record<string, unknown>[];
}

/** Excerpt quote cap — keeps the Slack message skimmable. */
const EXCERPT_CAP = 300;
/** Cap on the linked title — wp.org titles are short in practice, but the
 *  payload must stay bounded even for a pathological one. */
const TITLE_CAP = 200;
/** Draft cap — Slack blocks have a ~3000-char text limit per section; this
 *  stays comfortably under it while still showing a useful chunk of the draft.
 *  Shared by the first-reply draft and the follow-up draft. */
const DRAFT_CAP = 1500;
/** Abort the webhook POST after this long — never let a hung Slack request
 *  stall the caller's chain. */
const REQUEST_TIMEOUT_MS = 10_000;

export function slackConfigured(): boolean {
  return envSlackConfigured();
}

/** Truncate to at most `max` characters, appending an ellipsis when cut. */
function truncate(text: string, max: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max).trimEnd()}…`;
}

/** Escape Slack mrkdwn's three reserved characters in user-supplied text. */
function escapeMrkdwn(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Build the Slack Incoming Webhook payload for a wp.org topic event. Pure (no
 * network, no env access) so tests can assert on the exact shape without
 * stubbing fetch. mrkdwn blocks: a header line (event + plugin + linked
 * title), then for "new_topic" the author and a capped excerpt quote (omitted
 * for "new_reply" — the stored excerpt/author describe the topic's ORIGINAL
 * first post, not the fresh reply, and would mislead), the capped draft (or a
 * note that one couldn't be generated yet), and a final "review in YayAssist"
 * context line.
 */
export function buildSlackTopicPayload(
  input: SlackTopicNotificationInput
): SlackPayload {
  const kind: SlackTopicKind = input.kind ?? "new_topic";
  const isReply = kind === "new_reply";
  // Every user-influenced string gets escaped — INCLUDING the draft: it is
  // LLM output generated from the untrusted topic body, so a prompt-injected
  // "<https://evil|verify>" would otherwise render as a live link in Slack
  // (triple-backtick fencing does not reliably suppress Slack's <> parsing).
  const title = truncate(escapeMrkdwn(input.title), TITLE_CAP);
  const author = input.author ? escapeMrkdwn(input.author) : "unknown";
  const excerpt = truncate(escapeMrkdwn(input.excerpt), EXCERPT_CAP);

  const headerLabel = isReply
    ? `:speech_balloon: *New customer reply — ${escapeMrkdwn(input.pluginName)}*`
    : `:speech_balloon: *New wp.org topic — ${escapeMrkdwn(input.pluginName)}*`;
  const draftLabel = isReply ? "*Suggested follow-up:*" : "*Draft:*";
  const noDraftLine = isReply
    ? "_A follow-up draft couldn't be generated yet — open /suggestions and hit Regenerate._"
    : "_A draft reply couldn't be generated yet — open /suggestions to draft one manually._";

  const draftSection = input.draftAnswer
    ? {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `${draftLabel}\n\`\`\`${truncate(escapeMrkdwn(input.draftAnswer), DRAFT_CAP)}\`\`\``,
        },
      }
    : {
        type: "section",
        text: { type: "mrkdwn", text: noDraftLine },
      };

  const blocks: Record<string, unknown>[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${headerLabel}\n<${input.url}|${title}>`,
      },
    },
    // Author + excerpt describe the topic's opening post — meaningful when
    // announcing the topic itself, misleading when announcing a later reply.
    ...(isReply
      ? []
      : [
          {
            type: "section",
            text: { type: "mrkdwn", text: `Author: ${author}` },
          },
          {
            type: "section",
            text: { type: "mrkdwn", text: `> ${excerpt || "(no excerpt)"}` },
          },
        ]),
    draftSection,
    {
      type: "context",
      elements: [
        { type: "mrkdwn", text: "Review in YayAssist → /suggestions" },
      ],
    },
  ];

  return {
    text: isReply
      ? `New customer reply for ${input.pluginName}: ${input.title}`
      : `New wp.org topic for ${input.pluginName}: ${input.title}`,
    blocks,
  };
}

/** Back-compat alias for the pre-`kind` builder name. */
export const buildSlackNewTopicPayload = buildSlackTopicPayload;

async function postOnce(
  webhookUrl: string,
  payload: SlackPayload
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Notify the configured Slack channel of a wp.org topic event — a newly
 * created customer-last topic ("new_topic") or a fresh customer reply on an
 * already-tracked topic ("new_reply"). No-op (returns false, no network call)
 * when SLACK_WEBHOOK_URL isn't set. Retries ONCE on a network error or 5xx
 * response; a 4xx is treated as non-retryable (bad payload / revoked webhook
 * won't fix itself). NEVER throws — final failure is logged (tagged
 * "[slack]") and resolves false so callers can wrap this with plain failure
 * isolation, no try/catch required.
 */
export async function notifySlackTopic(
  input: SlackTopicNotificationInput
): Promise<boolean> {
  if (!slackConfigured()) return false;
  const webhookUrl = getEnv().SLACK_WEBHOOK_URL;
  if (!webhookUrl) return false;

  const payload = buildSlackTopicPayload(input);
  let lastError: string | null = null;

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await postOnce(webhookUrl, payload);
      if (res.ok) return true;
      lastError = `status ${res.status}`;
      if (res.status < 500) break; // non-retryable client error
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  console.error(
    `[slack] notify failed for thread ${input.threadId}: ${lastError}`
  );
  return false;
}

/** Back-compat alias for the pre-`kind` notify name. */
export const notifySlackNewTopic = notifySlackTopic;
