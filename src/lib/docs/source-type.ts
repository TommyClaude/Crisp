import { isWpOrgForumUrl } from "@/lib/wporg/forum-crawler";

/**
 * Docs-source type literals — matches `DocsSource.type` in the DB and the
 * `POST /api/docs/sources` request schema (src/app/api/docs/sources/route.ts):
 * "url" is a same-origin crawl starting at that address, "sitemap" walks a
 * sitemap.xml's <loc> entries, "wporg_forum" imports a wp.org plugin support
 * forum's answered topics as Q&A transcripts.
 */
export type DocsSourceType = "url" | "sitemap" | "wporg_forum";

/**
 * Guess a docs source's type from its URL alone, so the Add-source UI can
 * auto-detect the type instead of asking the user to pick it from a dropdown:
 *
 *   - a wordpress.org plugin support-forum URL (any http(s)/www/query
 *     variant of wordpress.org/support/plugin/<slug>/) -> "wporg_forum"
 *   - a URL whose last path segment ends with ".xml" or contains "sitemap"
 *     (case-insensitive) -> "sitemap" (sitemap.xml, sitemap_index.xml,
 *     wp-sitemap.xml, docs-sitemap.xml, ...) — "sitemap" appearing earlier in
 *     the path but not in the last segment does NOT count, to avoid
 *     misclassifying an ordinary docs page that merely lives under a
 *     "/sitemap/" section
 *   - everything else, including strings that don't even parse as a URL
 *     -> "url" (a same-origin crawl)
 *
 * Pure and synchronous (only reuses the forum-crawler's URL predicate) — safe
 * to call on every keystroke.
 */
export function detectSourceType(url: string): DocsSourceType {
  if (isWpOrgForumUrl(url)) return "wporg_forum";

  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return "url";
  }

  const segments = pathname.split("/").filter(Boolean);
  const lastSegment = (segments[segments.length - 1] ?? "").toLowerCase();
  if (lastSegment.endsWith(".xml") || lastSegment.includes("sitemap")) {
    return "sitemap";
  }

  return "url";
}
