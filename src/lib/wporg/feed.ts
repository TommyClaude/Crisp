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

/** Parse RSS items; keep only new TOPICS (links without a #post- anchor). */
export function parseForumFeed(xml: string): ForumTopic[] {
  const topics: ForumTopic[] = [];
  const seen = new Set<string>();

  for (const match of xml.matchAll(/<item[\s>][\s\S]*?<\/item>/gi)) {
    const item = match[0];
    const link = tagContent(item, "link");
    const rawGuid = tagContent(item, "guid") ?? link;
    const title = tagContent(item, "title");
    if (!link || !rawGuid || !title) continue;

    // Replies carry a #post-NNN fragment — skip them; we only want topics.
    if (/#post-\d+/.test(link) || /#post-\d+/.test(rawGuid)) continue;

    const url = link.split("#")[0];
    const guid = rawGuid.split("#")[0];
    if (seen.has(guid)) continue;
    seen.add(guid);

    const description =
      tagContent(item, "content:encoded") ?? tagContent(item, "description") ?? "";
    const pubDate = tagContent(item, "pubDate");
    const publishedAt = pubDate ? new Date(pubDate) : null;

    topics.push({
      guid,
      url,
      title: stripHtml(title),
      author: tagContent(item, "dc:creator")
        ? stripHtml(tagContent(item, "dc:creator")!)
        : null,
      excerpt: stripHtml(description).slice(0, MAX_EXCERPT_CHARS),
      publishedAt:
        publishedAt && !Number.isNaN(publishedAt.getTime()) ? publishedAt : null,
    });
  }
  return topics;
}

/** Fetch and parse a plugin's forum feed. Throws on HTTP/network failure. */
export async function fetchForumTopics(wpOrgSlug: string): Promise<ForumTopic[]> {
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
    return parseForumFeed(await response.text());
  } finally {
    clearTimeout(timer);
  }
}
