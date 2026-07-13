import { getEnv } from "@/env";

/**
 * Minimal documentation crawler (no parser dependencies).
 *
 * Two modes:
 *   - "url":     breadth-first crawl starting at the URL, restricted to the
 *                same origin AND the same path prefix (a start URL of
 *                https://example.com/docs/filebird/ never leaves /docs/filebird/).
 *   - "sitemap": fetch a sitemap.xml and crawl every <loc> entry.
 *
 * Extraction is heuristic (regex-based): prefer <main>/<article> content,
 * drop chrome (nav/header/footer/aside/script/style), convert block ends to
 * newlines, strip tags, decode entities. Good enough for documentation
 * pages; swap in a real parser here if a docs site defeats it.
 */

export interface CrawledPage {
  url: string;
  title: string | null;
  contentText: string;
}

export interface CrawlOptions {
  maxPages?: number;
  delayMs?: number;
  timeoutMs?: number;
}

const DEFAULTS: Required<Omit<CrawlOptions, "maxPages">> = {
  delayMs: 300,
  timeoutMs: 15_000,
};

/**
 * Per-source page cap, env-tunable (DOCS_CRAWL_MAX_PAGES, default 300) so a
 * large docs site can be covered without a code change. Read at call time —
 * stats.ts surfaces the same number in the coverage panel's cap warning.
 */
export function docsCrawlCap(): number {
  return getEnv().DOCS_CRAWL_MAX_PAGES;
}

/** Minimum extracted characters for a page to be worth indexing. */
const MIN_CONTENT_CHARS = 120;

const SKIP_EXTENSIONS =
  /\.(png|jpe?g|gif|svg|webp|ico|css|js|json|xml|pdf|zip|gz|rar|mp4|mp3|woff2?|ttf|eot)(\?|$)/i;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

function stripBlocks(html: string, tag: string): string {
  return html.replace(
    new RegExp(`<${tag}[\\s>][\\s\\S]*?<\\/${tag}>`, "gi"),
    " "
  );
}

export function extractTitle(html: string): string | null {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!match) return null;
  const title = decodeEntities(match[1]).replace(/\s+/g, " ").trim();
  return title.length > 0 ? title.slice(0, 300) : null;
}

export function htmlToText(html: string): string {
  let content = html;

  // Prefer the semantic content container when the page has one.
  const main =
    content.match(/<main[\s>][\s\S]*?<\/main>/i)?.[0] ??
    content.match(/<article[\s>][\s\S]*?<\/article>/i)?.[0];
  if (main && main.length > 500) content = main;

  for (const tag of ["script", "style", "noscript", "svg", "iframe", "form"]) {
    content = stripBlocks(content, tag);
  }
  // Page chrome only matters when we fell back to <body>.
  for (const tag of ["nav", "header", "footer", "aside"]) {
    content = stripBlocks(content, tag);
  }

  content = content
    .replace(/<\/(p|div|li|h[1-6]|tr|section|blockquote|pre|table)>/gi, "\n")
    .replace(/<(br|hr)\s*\/?>/gi, "\n")
    .replace(/<li[\s>]/gi, "\n- <li ")
    .replace(/<[^>]+>/g, " ");

  content = decodeEntities(content);

  return content
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Normalize a discovered link: absolute, no fragment/query, or null. */
function normalizeLink(href: string, baseUrl: URL): URL | null {
  if (!href || href.startsWith("#")) return null;
  if (/^(mailto:|tel:|javascript:|data:)/i.test(href)) return null;
  let url: URL;
  try {
    url = new URL(href, baseUrl);
  } catch {
    return null;
  }
  if (url.origin !== baseUrl.origin) return null;
  if (SKIP_EXTENSIONS.test(url.pathname)) return null;
  url.hash = "";
  url.search = ""; // docs pages are path-addressed; queries usually mean dupes
  return url;
}

export function extractLinks(html: string, baseUrl: URL): URL[] {
  const links: URL[] = [];
  const seen = new Set<string>();
  for (const match of html.matchAll(/<a[^>]+href=["']([^"']+)["']/gi)) {
    const url = normalizeLink(match[1], baseUrl);
    if (url && !seen.has(url.href)) {
      seen.add(url.href);
      links.push(url);
    }
  }
  return links;
}

export async function fetchHtml(
  url: string,
  timeoutMs: number
): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent": "YayAssistDocsBot/1.0 (internal support tool)",
        Accept: "text/html,application/xhtml+xml,application/xml",
      },
    });
    if (!response.ok) return null;
    const contentType = response.headers.get("content-type") ?? "";
    if (!/text\/html|application\/xml|text\/xml|application\/xhtml/.test(contentType)) {
      return null;
    }
    return await response.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Path prefix a "url"-mode crawl must stay under. */
function crawlPrefix(start: URL): string {
  const path = start.pathname;
  if (path === "" || path === "/") return "/";
  return path.endsWith("/") ? path : `${path}/`;
}

function withinScope(url: URL, start: URL, prefix: string): boolean {
  return (
    url.pathname === start.pathname || url.pathname.startsWith(prefix)
  );
}

async function sitemapUrls(
  sitemapUrl: string,
  options: Required<CrawlOptions>
): Promise<string[]> {
  const xml = await fetchHtml(sitemapUrl, options.timeoutMs);
  if (!xml) throw new Error(`Could not fetch sitemap: ${sitemapUrl}`);
  const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map(
    (m) => m[1].trim()
  );
  // Nested sitemap index — one level deep.
  const nested = locs.filter((l) => /sitemap[^/]*\.xml/i.test(l));
  if (nested.length > 0 && nested.length === locs.length) {
    const pages: string[] = [];
    for (const child of nested.slice(0, 10)) {
      const childXml = await fetchHtml(child, options.timeoutMs);
      if (!childXml) continue;
      pages.push(
        ...[...childXml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) =>
          m[1].trim()
        )
      );
      if (pages.length >= options.maxPages) break;
    }
    return pages.slice(0, options.maxPages);
  }
  return locs.slice(0, options.maxPages);
}

export async function crawlDocs(
  startUrl: string,
  type: "url" | "sitemap",
  crawlOptions?: CrawlOptions & {
    onProgress?: (fetched: number, queued: number) => void;
  }
): Promise<CrawledPage[]> {
  const options = {
    maxPages: crawlOptions?.maxPages ?? docsCrawlCap(),
    delayMs: crawlOptions?.delayMs ?? DEFAULTS.delayMs,
    timeoutMs: crawlOptions?.timeoutMs ?? DEFAULTS.timeoutMs,
    onProgress: crawlOptions?.onProgress,
  };
  const start = new URL(startUrl);
  const pages: CrawledPage[] = [];
  const visited = new Set<string>();

  const queue: string[] =
    type === "sitemap"
      ? (await sitemapUrls(startUrl, options)).filter((u) => {
          try {
            return !SKIP_EXTENSIONS.test(new URL(u).pathname);
          } catch {
            return false;
          }
        })
      : [start.href];
  const prefix = crawlPrefix(start);

  while (queue.length > 0 && pages.length < options.maxPages) {
    const url = queue.shift()!;
    if (visited.has(url)) continue;
    visited.add(url);

    const html = await fetchHtml(url, options.timeoutMs);
    if (html) {
      const contentText = htmlToText(html);
      if (contentText.length >= MIN_CONTENT_CHARS) {
        pages.push({ url, title: extractTitle(html), contentText });
      }
      if (type === "url") {
        for (const link of extractLinks(html, start)) {
          if (!visited.has(link.href) && withinScope(link, start, prefix)) {
            queue.push(link.href);
          }
        }
      }
    }
    crawlOptions?.onProgress?.(pages.length, queue.length);
    if (queue.length > 0) await sleep(options.delayMs);
  }

  return pages;
}
