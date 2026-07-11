/**
 * WordPress.org author → plugins lookup.
 *
 * A brand can carry a wordpress.org author username (its `wpProfileSlug`, e.g.
 * "ninjateam" from wordpress.org/plugins/author/ninjateam/). This module asks
 * the official Plugin Info API for every plugin published by that author, so
 * the /brands page can bulk-create a Plugin row (and idle forum Q&A source)
 * for each one with a single click.
 *
 * Only the fields we need are requested (slug + name); the heavy description
 * payload is disabled. Results are paginated but hard-capped so a prolific or
 * malformed author can never make the importer walk forever.
 */

const API_BASE = "https://api.wordpress.org/plugins/info/1.2/";
const PER_PAGE = 100;
const MAX_PAGES = 3;
const MAX_PLUGINS = 300;
const FETCH_TIMEOUT_MS = 15_000;
const USER_AGENT = "YayAssistImporter/1.0 (internal support tool)";

export interface AuthorPlugin {
  slug: string;
  name: string;
}

interface QueryPluginsResponse {
  info?: { page?: number; pages?: number };
  plugins?: Array<{ slug?: string; name?: string }>;
}

function buildUrl(profileSlug: string, page: number): string {
  const params = new URLSearchParams({
    action: "query_plugins",
    "request[author]": profileSlug,
    "request[per_page]": String(PER_PAGE),
    "request[page]": String(page),
    // Drop the (large) description from every result — we only use slug+name.
    "request[fields][description]": "0",
  });
  return `${API_BASE}?${params.toString()}`;
}

async function fetchPage(profileSlug: string, page: number): Promise<QueryPluginsResponse> {
  const url = buildUrl(profileSlug, page);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/json",
      },
      cache: "no-store",
    });
  } catch (error) {
    throw new Error(
      `Could not reach the WordPress.org plugin API — ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw new Error(
      `WordPress.org plugin API returned HTTP ${response.status} for author "${profileSlug}".`
    );
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new Error(
      `WordPress.org plugin API returned invalid JSON for author "${profileSlug}".`
    );
  }

  // The API answers a bad request with `false` (not an object) — treat that,
  // and any non-object/array shape, as an error rather than "no plugins".
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    throw new Error(
      `WordPress.org plugin API returned an unexpected response for author "${profileSlug}".`
    );
  }
  const parsed = json as QueryPluginsResponse;
  if (!Array.isArray(parsed.plugins)) {
    throw new Error(
      `WordPress.org plugin API returned no plugin list for author "${profileSlug}".`
    );
  }
  return parsed;
}

/**
 * All plugins published by a wordpress.org author, as {slug, name}. Paginates
 * until the API reports the last page (or the 3-page / 300-plugin cap). An
 * author with no plugins returns []. Throws a readable Error on HTTP failure
 * or an invalid response shape.
 */
export async function fetchAuthorPlugins(
  profileSlug: string
): Promise<AuthorPlugin[]> {
  const slug = profileSlug.trim();
  if (!slug) return [];

  const out: AuthorPlugin[] = [];
  const seen = new Set<string>();
  let page = 1;
  let totalPages = 1;

  do {
    const data = await fetchPage(slug, page);
    for (const plugin of data.plugins ?? []) {
      const pluginSlug = typeof plugin.slug === "string" ? plugin.slug.trim() : "";
      const name = typeof plugin.name === "string" ? plugin.name : "";
      if (!pluginSlug || seen.has(pluginSlug)) continue;
      seen.add(pluginSlug);
      out.push({ slug: pluginSlug, name: name || pluginSlug });
      if (out.length >= MAX_PLUGINS) return out;
    }
    // `pages` tells us how many pages of results exist for this author.
    const reportedPages = data.info?.pages;
    totalPages =
      typeof reportedPages === "number" && reportedPages > 0 ? reportedPages : page;
    page += 1;
  } while (page <= totalPages && page <= MAX_PAGES && out.length < MAX_PLUGINS);

  return out;
}

/**
 * Decode the HTML entities wp.org returns in plugin names. Mirrors
 * feed.ts's decodeEntities (named + numeric decimal/hex forms) with the
 * couple of extra named entities the plugin API commonly emits (&#038; is the
 * numeric ampersand; &#8211;/&#8212; are en/em dashes).
 */
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

/**
 * Turn a wp.org plugin title into a short brand-friendly name: decode HTML
 * entities, then keep only the part before the first tagline separator
 * (" – " en dash, " — " em dash, " - " hyphen-with-spaces, or ": " colon).
 * Capped at 100 chars. If cutting would leave fewer than 2 characters (a title
 * that starts with a separator), the full decoded name is used instead.
 */
export function shortPluginName(rawName: string): string {
  const decoded = decodeEntities(rawName).trim();
  // First occurrence of any separator wins, so "A – B — C" cuts at " – ".
  const match = decoded.match(/\s[–—-]\s|:\s/);
  let short = decoded;
  if (match && match.index !== undefined) {
    const candidate = decoded.slice(0, match.index).trim();
    if (candidate.length >= 2) short = candidate;
  }
  return short.slice(0, 100).trim() || decoded.slice(0, 100).trim();
}
