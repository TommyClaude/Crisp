/**
 * Canonical identity form for a wp.org support-TOPIC URL — the one string both
 * ingestion paths (RSS feed watcher and email-push listener) store as
 * SupportThread.guid/url and use for row lookups, so a topic reached via
 * either path converges on a single row instead of forking into duplicates.
 *
 * Distinct from forum-crawler.ts's `canonicalForumUrl` (any forum URL, keeps
 * the path — used for fetch/anchor scoping) and its private href resolver:
 * this one reduces a topic link specifically to its bare permalink. Pure
 * string logic, no network/DB imports — unit-testable against fixtures.
 */

/**
 * Canonicalize a wp.org topic URL to the bare topic permalink: force https,
 * drop a leading www., strip the query and #post-N fragment and any /page/N/
 * reply-pagination suffix, and end with a single trailing slash. Returns null
 * when the URL isn't a recognizable /support/topic/<slug>/ link.
 */
export function canonicalizeTopicUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (!/(^|\.)wordpress\.org$/i.test(url.hostname)) return null;
  const match = url.pathname.match(/^\/support\/topic\/([^/]+)/i);
  if (!match) return null;
  const slug = match[1];
  if (!slug) return null;
  return `https://wordpress.org/support/topic/${slug}/`;
}

/** The <slug> segment of a topic URL (any spelling), or null when not a topic link. */
export function topicSlug(url: string): string | null {
  const canonical = canonicalizeTopicUrl(url);
  const match = canonical?.match(/\/support\/topic\/([^/]+)\//);
  return match ? match[1] : null;
}
