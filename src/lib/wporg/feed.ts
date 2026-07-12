import { getEnv } from "@/env";

/**
 * WordPress.org support-forum feed reader.
 *
 * Each plugin's forum exposes an RSS feed at
 *   https://wordpress.org/support/plugin/{slug}/feed/
 * containing recent posts — both new topics and replies. Replies link to
 * anchors like ...#post-123456; new topics link to the bare topic URL, which
 * is how we keep only fresh threads worth suggesting an answer for.
 */

export interface ForumTopic {
  guid: string;
  url: string;
  title: string;
  author: string | null;
  excerpt: string;
  publishedAt: Date | null;
}

/**
 * A reply item from the feed (a link carrying a #post-N anchor). Unlike a new
 * topic, a reply may bump a topic that is years old — so we keep the topic's
 * bare guid/url (anchor stripped, matching {@link ForumTopic.guid}) plus the
 * reply's own guid and publish date. The watcher canonicalizes these to the
 * bare topic permalink (topic-url.ts) before any SupportThread lookup/write,
 * and uses them to resurface an old topic that just got a fresh customer reply.
 */
export interface ForumReply {
  /** Topic guid with the #post-N anchor stripped (raw feed spelling). */
  topicGuid: string;
  /** Topic URL with the #post-N anchor stripped. */
  topicUrl: string;
  /** The reply's own feed guid (anchor kept) — dedupe/debug only. */
  replyGuid: string;
  /** The reply's publish date (null when the feed omits/mangles pubDate). */
  publishedAt: Date | null;
}

/** Both kinds of feed item: new topics and replies to existing topics. */
export interface ForumFeedItems {
  topics: ForumTopic[];
  replies: ForumReply[];
}

const FETCH_TIMEOUT_MS = 15_000;
/** Cap on the excerpt stored per thread. */
const MAX_EXCERPT_CHARS = 4000;

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => {
      const n = Number(code);
      return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : "";
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      const n = parseInt(hex, 16);
      return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : "";
    });
}

function stripHtml(html: string): string {
  return decodeEntities(
    html
      .replace(/<!\[CDATA\[|\]\]>/g, "")
      .replace(/<\/(p|div|li|br)>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
  )
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .join("\n")
    .replace(/\n{2,}/g, "\n\n")
    .trim();
}

function tagContent(xml: string, tag: string): string | null {
  // Handles both plain and CDATA-wrapped content; tags may carry attributes
  // and namespaced names contain ":" (e.g. dc:creator).
  const match = xml.match(
    new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i")
  );
  return match ? match[1].trim() : null;
}

export function feedUrlForSlug(wpOrgSlug: string): string {
  const base = getEnv().WPORG_FEED_BASE.replace(/\/$/, "");
  return `${base}/${encodeURIComponent(wpOrgSlug)}/feed/`;
}

function parsePubDate(item: string): Date | null {
  const pubDate = tagContent(item, "pubDate");
  const parsed = pubDate ? new Date(pubDate) : null;
  return parsed && !Number.isNaN(parsed.getTime()) ? parsed : null;
}

/**
 * Parse RSS items into BOTH new topics (links without a #post- anchor) and
 * replies (links carrying one). Topics are deduped by topic guid; replies are
 * deduped by their own guid (a topic may legitimately have several replies —
 * the watcher collapses those to the newest per topic).
 */
export function parseForumFeedItems(xml: string): ForumFeedItems {
  const topics: ForumTopic[] = [];
  const replies: ForumReply[] = [];
  const seenTopics = new Set<string>();
  const seenReplies = new Set<string>();

  for (const match of xml.matchAll(/<item[\s>][\s\S]*?<\/item>/gi)) {
    const item = match[0];
    const link = tagContent(item, "link");
    const rawGuid = tagContent(item, "guid") ?? link;
    if (!link || !rawGuid) continue;

    // Replies carry a #post-NNN fragment on the link and/or guid.
    if (/#post-\d+/.test(link) || /#post-\d+/.test(rawGuid)) {
      const replyGuid = rawGuid;
      if (seenReplies.has(replyGuid)) continue;
      seenReplies.add(replyGuid);
      replies.push({
        topicGuid: rawGuid.split("#")[0],
        topicUrl: link.split("#")[0],
        replyGuid,
        publishedAt: parsePubDate(item),
      });
      continue;
    }

    const title = tagContent(item, "title");
    if (!title) continue;

    const url = link.split("#")[0];
    const guid = rawGuid.split("#")[0];
    if (seenTopics.has(guid)) continue;
    seenTopics.add(guid);

    const description =
      tagContent(item, "content:encoded") ?? tagContent(item, "description") ?? "";

    topics.push({
      guid,
      url,
      title: stripHtml(title),
      author: tagContent(item, "dc:creator")
        ? stripHtml(tagContent(item, "dc:creator")!)
        : null,
      excerpt: stripHtml(description).slice(0, MAX_EXCERPT_CHARS),
      publishedAt: parsePubDate(item),
    });
  }
  return { topics, replies };
}

/** Parse RSS items; keep only new TOPICS (back-compat topic-only view). */
export function parseForumFeed(xml: string): ForumTopic[] {
  return parseForumFeedItems(xml).topics;
}

async function fetchFeedXml(wpOrgSlug: string): Promise<string> {
  const url = feedUrlForSlug(wpOrgSlug);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent": "YayAssistForumWatcher/1.0 (internal support tool)",
        Accept: "application/rss+xml, application/xml, text/xml",
      },
      cache: "no-store",
    });
    if (!response.ok) {
      throw new Error(`Feed request failed: HTTP ${response.status} for ${url}`);
    }
    return response.text();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch and parse a plugin's forum feed into topics AND replies. Throws on
 * HTTP/network failure.
 */
export async function fetchForumFeed(
  wpOrgSlug: string
): Promise<ForumFeedItems> {
  return parseForumFeedItems(await fetchFeedXml(wpOrgSlug));
}

/**
 * Fetch and parse a plugin's forum feed (topics only). Throws on HTTP/network
 * failure. Kept for back-compat with topic-only consumers.
 */
export async function fetchForumTopics(wpOrgSlug: string): Promise<ForumTopic[]> {
  return parseForumFeed(await fetchFeedXml(wpOrgSlug));
}
