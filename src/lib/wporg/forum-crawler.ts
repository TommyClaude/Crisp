import {
  fetchHtml,
  htmlToText,
  extractTitle,
  type CrawledPage,
} from "@/lib/docs/crawler";

/**
 * WordPress.org support-forum Q&A crawler.
 *
 * Walks a plugin's forum listing (https://wordpress.org/support/plugin/{slug}/,
 * paginated as /page/N/), fetches every answered topic, and renders each one
 * as a plain-text Q&A transcript (question + replies, with author roles like
 * "Plugin Support" preserved). The output is CrawledPage-compatible so forum
 * topics flow through the exact same ingest pipeline as documentation pages:
 * DocsPage rows, PII redaction, chunking, embeddings.
 *
 * Parsing is regex-based against bbPress's stable theme-compat markup
 * (div id="post-N", bbp-reply-content, bbp-topic-permalink, ...) with
 * defensive fallbacks — a topic that fails to parse is skipped, never stored
 * half-broken. Topics with zero replies are skipped: an unanswered question
 * teaches the assistant nothing.
 */

export interface ForumCrawlOptions {
  /** Max threads fetched per ingest run (newest first). */
  maxThreads?: number;
  /** Max listing pages to walk (30 topics per page). */
  maxListingPages?: number;
  /** Max reply pages fetched per thread (long threads paginate). */
  maxReplyPagesPerThread?: number;
  delayMs?: number;
  timeoutMs?: number;
  onProgress?: (fetchedThreads: number, queuedThreads: number) => void;
}

const DEFAULTS: Required<Omit<ForumCrawlOptions, "onProgress">> = {
  maxThreads: 200,
  maxListingPages: 30,
  maxReplyPagesPerThread: 5,
  delayMs: 600,
  timeoutMs: 15_000,
};

/** Minimum combined Q&A characters for a thread to be worth indexing. */
const MIN_THREAD_CHARS = 80;

/** Recognizes a wp.org plugin support-forum listing URL. */
export function isWpOrgForumUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      /(^|\.)wordpress\.org$/i.test(parsed.hostname) &&
      /^\/support\/plugin\/[^/]+\/?$/i.test(parsed.pathname)
    );
  } catch {
    return false;
  }
}

/** Canonical forum listing URL for a wp.org plugin slug. */
export function forumUrlForSlug(wpOrgSlug: string): string {
  return `https://wordpress.org/support/plugin/${encodeURIComponent(wpOrgSlug)}/`;
}

/**
 * Canonicalize a wp.org forum URL: force https, drop a leading "www.",
 * strip query/fragment, ensure a trailing slash. A user-pasted
 * `http://www.wordpress.org/support/plugin/x` and the canonical form then
 * resolve to the same origin, so topic-anchor scoping works.
 */
export function canonicalForumUrl(url: string): string {
  try {
    const u = new URL(url);
    // Only wordpress.org forums get protocol/www normalization (the feature is
    // wp.org-specific); other hosts keep their scheme so local/test URLs work.
    if (/(^|\.)wordpress\.org$/i.test(u.hostname)) {
      u.protocol = "https:";
      u.hostname = u.hostname.replace(/^www\./i, "");
    }
    u.hash = "";
    u.search = "";
    if (!u.pathname.endsWith("/")) u.pathname += "/";
    return u.href;
  } catch {
    return url;
  }
}

export interface ForumTopicRow {
  url: string;
  title: string;
  replyCount: number | null;
  resolved: boolean;
  sticky: boolean;
}

export interface ForumPost {
  /** bbPress post id (the number in `id="post-N"`) — used to de-dup. */
  id: string;
  author: string;
  /** wp.org badge next to the author: Plugin Author, Plugin Support, ... */
  role: string | null;
  text: string;
}

export interface ForumThreadPage {
  title: string | null;
  resolved: boolean;
  posts: ForumPost[];
  /** Whether a further reply page exists (…/page/N+1/). */
  hasMorePages: boolean;
}

function stripTags(html: string): string {
  return htmlToText(html).replace(/\s+/g, " ").trim();
}

/**
 * True when a fragment carries a "resolved" marker: the [Resolved] title
 * prefix wp.org renders in listings, or a resolved CSS class/tooltip.
 * "not-resolved" / "not resolved" must NOT count.
 */
export function looksResolved(fragment: string): boolean {
  if (/\[\s*resolved\s*\]/i.test(fragment)) return true;
  const classAttr = fragment.match(/class="([^"]*)"/gi) ?? [];
  for (const attr of classAttr) {
    if (/(?:^|[\s"])(?:topic-)?resolved(?:[\s"]|$)/i.test(attr)) return true;
  }
  return /title="[^"]*(?<!not[\s-])\bresolved\b[^"]*"/i.test(fragment);
}

/**
 * Extract the inner HTML of the <div> whose opening tag starts at
 * `openTagStart`, honoring nested divs. Returns null when unbalanced.
 */
function extractBalancedDiv(html: string, openTagStart: number): string | null {
  const openEnd = html.indexOf(">", openTagStart);
  if (openEnd === -1) return null;
  const re = /<div[\s>]|<\/div>/gi;
  re.lastIndex = openEnd + 1;
  let depth = 1;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html))) {
    depth += match[0].startsWith("</") ? -1 : 1;
    if (depth === 0) return html.slice(openEnd + 1, match.index);
  }
  return null;
}

/** Compare hosts ignoring a leading "www." (apex vs www are the same forum). */
function sameHost(a: string, b: string): boolean {
  return (
    a.replace(/^www\./i, "").toLowerCase() ===
    b.replace(/^www\./i, "").toLowerCase()
  );
}

/** Normalize a topic URL: absolute, no query/fragment, trailing slash. */
function normalizeTopicUrl(href: string, base: URL): string | null {
  let url: URL;
  try {
    url = new URL(href, base);
  } catch {
    return null;
  }
  if (!/\/support\/topic\/[^/]+/i.test(url.pathname)) return null;
  // Keep the crawl on the forum we started on. Compare by host (ignoring
  // www/protocol) rather than full origin so a http:// or www. listing URL
  // whose page serves absolute https://wordpress.org/... anchors still scopes.
  if (!sameHost(url.hostname, base.hostname)) return null;
  url.hash = "";
  url.search = "";
  // Strip reply pagination so each thread has one canonical URL.
  url.pathname = url.pathname.replace(/\/page\/\d+\/?$/i, "/");
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url.href;
}

/** Parse the topic rows out of a forum listing page. */
export function parseTopicRows(html: string, baseUrl: URL): ForumTopicRow[] {
  const rows: ForumTopicRow[] = [];
  const seen = new Set<string>();
  const rowStarts = [...html.matchAll(/<ul[^>]+id="bbp-topic-\d+"[^>]*>/gi)];

  for (let i = 0; i < rowStarts.length; i++) {
    const start = rowStarts[i].index!;
    const end = rowStarts[i + 1]?.index ?? html.length;
    const row = html.slice(start, end);

    // Topic permalink: first /support/topic/ anchor without a #post- fragment.
    let url: string | null = null;
    let title = "";
    for (const anchor of row.matchAll(
      /<a[^>]*href="([^"]*\/support\/topic\/[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi
    )) {
      if (/#post-\d+/.test(anchor[1])) continue;
      url = normalizeTopicUrl(anchor[1], baseUrl);
      title = stripTags(anchor[2]);
      if (url) break;
    }
    if (!url || seen.has(url)) continue;
    seen.add(url);

    const replyCell = row.match(
      /<li[^>]*class="[^"]*bbp-topic-reply-count[^"]*"[^>]*>([\s\S]*?)<\/li>/i
    );
    const replyCount = replyCell
      ? parseInt(stripTags(replyCell[1]).replace(/[,.]/g, ""), 10)
      : null;

    rows.push({
      url,
      title: title.replace(/^\[\s*resolved\s*\]\s*/i, ""),
      replyCount: Number.isFinite(replyCount as number) ? replyCount : null,
      resolved: looksResolved(rowStarts[i][0]) || looksResolved(row),
      sticky: /class="[^"]*\b(?:super-)?sticky\b[^"]*"/i.test(rowStarts[i][0]),
    });
  }
  return rows;
}

const ROLE_RE =
  /\b(Plugin Author|Plugin Support|Plugin Contributor|Moderator|Keymaster)\b/;

/** Parse one page of a topic (the question and/or its replies). */
export function parseTopicPage(html: string): ForumThreadPage {
  const posts: ForumPost[] = [];
  const postStarts = [...html.matchAll(/<div[^>]+id="post-\d+"[^>]*>/gi)];

  for (let i = 0; i < postStarts.length; i++) {
    const start = postStarts[i].index!;
    const end = postStarts[i + 1]?.index ?? html.length;
    const segment = html.slice(start, end);
    const postId = postStarts[i][0].match(/id="post-(\d+)"/i)?.[1] ?? `idx-${i}`;

    // Only segments with a bbPress content wrapper are real posts (this
    // filters page/article wrappers that reuse the post-N id convention).
    const contentOpen = segment.match(
      /<div[^>]*class="[^"]*\bbbp-(?:reply|topic)-content\b[^"]*"[^>]*>/i
    );
    if (!contentOpen || contentOpen.index === undefined) continue;
    const contentHtml =
      extractBalancedDiv(segment, contentOpen.index) ??
      segment.slice(contentOpen.index + contentOpen[0].length);
    const text = htmlToText(contentHtml);
    if (!text) continue;

    // Author name: first /support/users/ link before the content that has
    // visible text (the avatar link comes first and only wraps an <img>).
    const head = segment.slice(0, contentOpen.index);
    let author = "anonymous";
    for (const link of head.matchAll(
      /<a[^>]*href="[^"]*\/support\/users\/[^"]*"[^>]*>([\s\S]*?)<\/a>/gi
    )) {
      const name = stripTags(link[1]);
      if (name) {
        author = name;
        break;
      }
    }
    const role = stripTags(head).match(ROLE_RE)?.[1] ?? null;

    posts.push({ id: postId, author, role, text });
  }

  const title =
    extractTitle(html)
      ?.replace(/\s*[|–-]\s*WordPress\.org.*$/i, "")
      .replace(/^\[\s*resolved\s*\]\s*/i, "")
      .trim() || null;

  // Resolved marker: page <title> prefix or the topic-resolution status
  // block near the top of the page (before the first post).
  const headRegion = postStarts.length
    ? html.slice(0, postStarts[0].index!)
    : html;
  const resolved =
    /\[\s*resolved\s*\]/i.test(extractTitle(html) ?? "") ||
    looksResolved(headRegion);

  // Reply pagination present at all (any /page/N/ topic link). The crawl loop
  // uses hasTopicPage() for the precise "is there a NEXT page of THIS topic"
  // decision; this flag is only informational.
  const hasMorePages = /href="[^"]*\/support\/topic\/[^"]*\/page\/\d+\/?[^"]*"/i.test(
    html
  );

  return { title, resolved, posts, hasMorePages };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * True when `html` links to `/page/${pageNumber}/` of the SPECIFIC topic at
 * `topicUrl` — not just any topic pagination anywhere on the page. This keeps
 * the reply-page loop from chasing prev-page links (rendered on the last page
 * of long threads) or /page/N/ URLs a user pasted into a reply body.
 */
export function hasTopicPage(
  html: string,
  topicUrl: string,
  pageNumber: number
): boolean {
  let path: string;
  try {
    path = new URL(topicUrl).pathname.replace(/\/$/, "");
  } catch {
    return false;
  }
  const re = new RegExp(
    `href="[^"]*${escapeRegExp(path)}/page/${pageNumber}/`,
    "i"
  );
  return re.test(html);
}

/** Render a thread as a plain-text Q&A transcript for chunking. */
export function threadToTranscript(
  title: string,
  resolved: boolean,
  posts: ForumPost[]
): string {
  const lines: string[] = [
    `${resolved ? "[Resolved] " : ""}${title}`.trim(),
  ];
  posts.forEach((post, index) => {
    const role = post.role ? ` (${post.role})` : "";
    const label =
      index === 0 ? `Question from ${post.author}` : `Reply from ${post.author}${role}`;
    lines.push(`${label}:\n${post.text}`);
  });
  return lines.join("\n\n").trim();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Crawl a plugin's wp.org support forum into CrawledPage transcripts.
 * One CrawledPage per answered thread; `title` carries a "[Resolved]" prefix
 * when wp.org marks the topic resolved.
 */
export async function crawlForum(
  listingUrl: string,
  crawlOptions?: ForumCrawlOptions
): Promise<CrawledPage[]> {
  const options = { ...DEFAULTS, ...crawlOptions };
  // Canonicalize (https, no www, trailing slash) so topic-anchor scoping and
  // page URLs are consistent regardless of how the URL was pasted/stored.
  const listingBase = canonicalForumUrl(listingUrl);
  const base = new URL(listingBase);

  // 1) Walk the listing pages and collect candidate threads.
  const topics: ForumTopicRow[] = [];
  const seenUrls = new Set<string>();
  for (let page = 1; page <= options.maxListingPages; page++) {
    const url = page === 1 ? listingBase : `${listingBase}page/${page}/`;
    const html = await fetchHtml(url, options.timeoutMs);
    if (!html) {
      // Page 1 failing means the listing itself is unreachable — surface that
      // instead of the misleading "no threads found" below. Later pages
      // failing just ends the walk (past the last page, or a transient blip).
      if (page === 1) {
        throw new Error(
          `Could not fetch the forum listing at ${url} — network error, ` +
            "rate limit, or the URL is not a reachable wp.org support forum."
        );
      }
      break;
    }
    const rows = parseTopicRows(html, base);
    const fresh = rows.filter((row) => !seenUrls.has(row.url));
    if (fresh.length === 0) break; // empty or repeating page — done.
    for (const row of fresh) {
      seenUrls.add(row.url);
      topics.push(row);
    }
    if (topics.length >= options.maxThreads * 1.5) break;
    await sleep(options.delayMs);
  }

  if (topics.length === 0) {
    throw new Error(
      "No forum topics found — check that the URL is a wp.org plugin support forum " +
        "(https://wordpress.org/support/plugin/{slug}/)."
    );
  }

  // 2) Keep answered, non-sticky threads (stickies are announcements).
  const queue = topics
    .filter((t) => !t.sticky)
    .filter((t) => t.replyCount === null || t.replyCount > 0)
    .slice(0, options.maxThreads);

  // 3) Fetch each thread (following reply pagination) and build transcripts.
  const pages: CrawledPage[] = [];
  for (const topic of queue) {
    await sleep(options.delayMs);
    let currentHtml = await fetchHtml(topic.url, options.timeoutMs);
    if (!currentHtml) continue;

    // De-dup posts by bbPress post id: wp.org repeats the lead topic (the
    // question) at the top of EVERY reply page, so without this the question
    // would be appended once per page.
    const posts: ForumPost[] = [];
    const seenPostIds = new Set<string>();
    const addPosts = (incoming: ForumPost[]) => {
      for (const post of incoming) {
        if (seenPostIds.has(post.id)) continue;
        seenPostIds.add(post.id);
        posts.push(post);
      }
    };

    const firstPage = parseTopicPage(currentHtml);
    addPosts(firstPage.posts);
    // Title + resolved come from page 1 only (later pages carry a "Page N"
    // suffix in <title> and no resolution block).
    const parsedTitle = firstPage.title;
    const parsedResolved = firstPage.resolved;

    let replyPage = 2;
    while (
      replyPage <= options.maxReplyPagesPerThread &&
      hasTopicPage(currentHtml, topic.url, replyPage)
    ) {
      await sleep(options.delayMs);
      const moreHtml = await fetchHtml(
        `${topic.url}page/${replyPage}/`,
        options.timeoutMs
      );
      if (!moreHtml) break;
      addPosts(parseTopicPage(moreHtml).posts);
      currentHtml = moreHtml;
      replyPage += 1;
    }

    // An unanswered thread (question only) teaches nothing — skip.
    if (posts.length < 2) continue;

    const title = parsedTitle ?? topic.title ?? topic.url;
    const resolved = topic.resolved || parsedResolved;
    const contentText = threadToTranscript(title, resolved, posts);
    if (contentText.length < MIN_THREAD_CHARS) continue;

    pages.push({
      url: topic.url,
      title: `${resolved ? "[Resolved] " : ""}${title}`,
      contentText,
    });
    crawlOptions?.onProgress?.(pages.length, queue.length - pages.length);
  }

  return pages;
}
