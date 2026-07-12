/**
 * Pure parsing helpers for the wp.org email-push listener
 * (src/lib/wporg/mail-listener.ts). Kept free of any IMAP/network/DB imports so
 * every rule here is unit-testable against static fixtures.
 *
 * wordpress.org emails a subscribed account on every new topic and every reply.
 * A dedicated Gmail inbox collects those forwarded "WordPress.org Forums"
 * notifications; the listener fetches each message's raw source, decodes its
 * text/HTML bodies here ({@link extractEmailBodies}), then extracts the topic
 * URL and plugin hint ({@link parseNotificationEmail}) to drive a targeted
 * single-topic check.
 */

import { canonicalizeTopicUrl } from "@/lib/wporg/topic-url";

/** What a notification email tells us: which topic, and (maybe) which plugin. */
export interface ParsedNotification {
  /** Canonical wp.org topic URL (no #anchor, no query, no /page/N/). */
  topicUrl: string;
  /**
   * Plugin name/slug guessed from the subject's leading "[Bracket]" — wp.org
   * forum notification subjects read "[Plugin Name] Topic title". null when the
   * subject has no leading bracket; the listener then resolves the plugin from
   * the fetched topic page instead.
   */
  pluginHint: string | null;
}

/** Input to {@link parseNotificationEmail}: a decoded subject plus either body. */
export interface NotificationEmailInput {
  subject: string;
  /** Decoded text/plain body (may be empty). */
  text?: string | null;
  /** Decoded text/html body (may be empty). */
  html?: string | null;
}

/** Decoded bodies pulled out of a raw RFC822 message. */
export interface ExtractedBodies {
  /** Subject from the raw headers (decoded), or null when absent/unparseable. */
  subject: string | null;
  text: string;
  html: string;
}

/**
 * Matches a wp.org support-topic URL anywhere in a body. The slug is the first
 * path segment after /support/topic/; everything after (a trailing slash,
 * /page/N/, a #post-N anchor, a ?query) is captured loosely and trimmed by
 * {@link canonicalizeTopicUrl}. Case-insensitive host, http or https, optional www.
 */
const TOPIC_URL_RE =
  /https?:\/\/(?:www\.)?wordpress\.org\/support\/topic\/[^\s"'<>)]+/gi;

/** Leading "[Plugin Name]" bracket in a subject line. */
const SUBJECT_BRACKET_RE = /^\s*\[([^\]]+)\]/;

/**
 * Extract the topic URL + plugin hint from a wp.org forum notification.
 *
 * Handles both notification shapes — a new-topic mail links the bare topic URL;
 * a reply mail links the post anchor (…/#post-N, sometimes …/page/2/#post-N) —
 * because {@link canonicalizeTopicUrl} strips the anchor and pagination either
 * way. The URL is searched in the text body first, then the HTML body (a URL
 * can live in either), so the plaintext part is preferred when both exist.
 *
 * Returns null for mail with no recognizable wp.org topic link (the listener
 * advances its cursor and counts it as skipped).
 */
export function parseNotificationEmail(
  input: NotificationEmailInput
): ParsedNotification | null {
  // Search text first (cleaner), then HTML — the first normalizable match wins.
  const haystacks = [input.text ?? "", input.html ?? ""];
  let topicUrl: string | null = null;
  for (const body of haystacks) {
    for (const rawMatch of body.matchAll(TOPIC_URL_RE)) {
      const normalized = canonicalizeTopicUrl(rawMatch[0]);
      if (normalized) {
        topicUrl = normalized;
        break;
      }
    }
    if (topicUrl) break;
  }
  if (!topicUrl) return null;

  const bracket = input.subject.match(SUBJECT_BRACKET_RE);
  const pluginHint = bracket ? bracket[1].trim() || null : null;

  return { topicUrl, pluginHint };
}

/** Split a raw message/part into its header block and body at the first blank line. */
function splitHeadersBody(raw: string): { headers: string; body: string } {
  const normalized = raw.replace(/\r\n/g, "\n");
  const idx = normalized.indexOf("\n\n");
  if (idx === -1) return { headers: normalized, body: "" };
  return {
    headers: normalized.slice(0, idx),
    body: normalized.slice(idx + 2),
  };
}

/** Unfold RFC822 headers (continuation lines start with whitespace) and read one. */
function readHeader(headers: string, name: string): string | null {
  const unfolded = headers.replace(/\n[ \t]+/g, " ");
  const re = new RegExp(`^${name}:\\s*(.*)$`, "im");
  const match = unfolded.match(re);
  return match ? match[1].trim() : null;
}

/** Decode a quoted-printable body (soft line breaks + =XX escapes). */
function decodeQuotedPrintable(body: string): string {
  const bytes: number[] = [];
  // Join soft line breaks first ("=" at end of line), then walk the string.
  const joined = body.replace(/=\r?\n/g, "");
  for (let i = 0; i < joined.length; i++) {
    const ch = joined[i];
    if (ch === "=" && i + 2 < joined.length) {
      const hex = joined.slice(i + 1, i + 3);
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        bytes.push(parseInt(hex, 16));
        i += 2;
        continue;
      }
    }
    bytes.push(ch.charCodeAt(0) & 0xff);
  }
  return Buffer.from(bytes).toString("utf8");
}

/** Decode a body per its Content-Transfer-Encoding (qp / base64 / plain). */
function decodeBody(body: string, encoding: string | null): string {
  const enc = (encoding ?? "").toLowerCase();
  if (enc === "base64") {
    return Buffer.from(body.replace(/\s+/g, ""), "base64").toString("utf8");
  }
  if (enc === "quoted-printable") {
    return decodeQuotedPrintable(body);
  }
  return body;
}

/** Read a MIME parameter (e.g. boundary, charset) from a Content-Type value. */
function contentTypeParam(contentType: string, param: string): string | null {
  const re = new RegExp(`${param}\\s*=\\s*"?([^";]+)"?`, "i");
  const match = contentType.match(re);
  return match ? match[1].trim() : null;
}

/**
 * Recursively collect the decoded text/plain and text/html leaves of one MIME
 * part into `out`. Depth-bounded so a malformed/self-referential structure
 * can't loop forever. Non-text leaves (attachments, images) are ignored.
 */
function collectParts(
  raw: string,
  out: { text: string[]; html: string[] },
  depth: number
): void {
  if (depth > 8) return;
  const { headers, body } = splitHeadersBody(raw);
  const contentType = readHeader(headers, "Content-Type") ?? "text/plain";
  const lowerType = contentType.toLowerCase();

  if (lowerType.startsWith("multipart/")) {
    const boundary = contentTypeParam(contentType, "boundary");
    if (!boundary) return;
    // Split on the boundary delimiter; the first chunk is the preamble and the
    // last is the closing "--boundary--" epilogue — both are ignored because
    // they have no headers/body of their own.
    const marker = `--${boundary}`;
    const segments = body.split(marker);
    for (const segment of segments) {
      const trimmed = segment.replace(/^\r?\n/, "");
      // Skip the preamble (before the first boundary) and the closing marker.
      if (trimmed === "" || trimmed.startsWith("--")) continue;
      collectParts(trimmed, out, depth + 1);
    }
    return;
  }

  const encoding = readHeader(headers, "Content-Transfer-Encoding");
  const decoded = decodeBody(body, encoding);
  if (lowerType.startsWith("text/html")) {
    out.html.push(decoded);
  } else if (lowerType.startsWith("text/plain")) {
    out.text.push(decoded);
  }
}

/**
 * Decode the text/plain and text/html bodies out of a raw RFC822 message
 * (imapflow's `source` buffer, as a string). Walks multipart/alternative and
 * multipart/mixed trees, decoding quoted-printable and base64 parts. The
 * listener passes the results to {@link parseNotificationEmail}. Best-effort:
 * on anything it can't parse it returns whatever it found (possibly empty
 * strings) rather than throwing.
 */
export function extractEmailBodies(rawSource: string): ExtractedBodies {
  const out = { text: [] as string[], html: [] as string[] };
  const { headers } = splitHeadersBody(rawSource);
  const subject = readHeader(headers, "Subject");
  try {
    collectParts(rawSource, out, 0);
  } catch {
    // Malformed MIME — fall through with whatever was collected.
  }
  return {
    subject,
    text: out.text.join("\n").trim(),
    html: out.html.join("\n").trim(),
  };
}
