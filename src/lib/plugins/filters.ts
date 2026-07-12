/**
 * Pure client-side filtering logic for the /plugins page — no DB access, so
 * it's safe to import from client components and to unit-test directly.
 *
 * The Status filter is derived entirely from the docs-sources shape each
 * plugin already carries (no extra query): a plugin is missing a docs
 * source, missing a forum Q&A source, or "never ingested" purely by looking
 * at the `type`/`url`/`chunkCount` of its `docsSources`.
 */

export interface PluginSourceForFilter {
  type: string;
  url: string;
  chunkCount: number;
}

export interface PluginForFilter {
  brand: { id: string };
  docsSources: PluginSourceForFilter[];
}

/**
 * A docs source counts as a "forum Q&A" source by type OR by URL — a legacy
 * "url"-typed forum row (healed to "wporg_forum" only on its next ingest)
 * must still count as the plugin's forum source, not as a docs source.
 * Mirrors the PluginCard `hasForumSource` check so the filter and the "Add
 * wp.org forum Q&A source" button agree on what counts as a forum source.
 */
const FORUM_URL_PATTERN = /\/\/(?:[^/]*\.)?wordpress\.org\/support\/plugin\//i;

export function isForumSource(source: PluginSourceForFilter): boolean {
  return source.type === "wporg_forum" || FORUM_URL_PATTERN.test(source.url);
}

/** Has a wp.org forum Q&A source. */
export function hasForumSource(sources: PluginSourceForFilter[]): boolean {
  return sources.some(isForumSource);
}

/** Has a documentation source (URL/sitemap crawl) — anything not a forum source. */
export function hasDocsSource(sources: PluginSourceForFilter[]): boolean {
  return sources.some((source) => !isForumSource(source));
}

/**
 * Has at least one docs source, but none of them have ever produced a
 * chunk — covers both "never crawled" (chunkCount defaults to 0) and
 * "crawled but yielded nothing" alike. A plugin with zero sources is NOT
 * "never ingested" (it's "missing docs source" / "missing forum Q&A"
 * instead) — there's nothing to have ingested.
 */
export function isNeverIngested(sources: PluginSourceForFilter[]): boolean {
  return sources.length > 0 && sources.every((source) => source.chunkCount === 0);
}

export const PLUGIN_STATUS_FILTERS = [
  "missing_docs",
  "missing_forum",
  "never_ingested",
] as const;

export type PluginStatusFilter = (typeof PLUGIN_STATUS_FILTERS)[number];

export function isPluginStatusFilter(
  value: string | null
): value is PluginStatusFilter {
  return (PLUGIN_STATUS_FILTERS as readonly string[]).includes(value ?? "");
}

export function matchesStatusFilter(
  sources: PluginSourceForFilter[],
  status: PluginStatusFilter | null
): boolean {
  switch (status) {
    case "missing_docs":
      return !hasDocsSource(sources);
    case "missing_forum":
      return !hasForumSource(sources);
    case "never_ingested":
      return isNeverIngested(sources);
    case null:
      return true;
  }
}

export interface PluginFilters {
  /** Brand.id to keep, or null for "all brands". */
  brandId: string | null;
  status: PluginStatusFilter | null;
}

export function matchesPluginFilters(
  plugin: PluginForFilter,
  filters: PluginFilters
): boolean {
  if (filters.brandId && plugin.brand.id !== filters.brandId) return false;
  return matchesStatusFilter(plugin.docsSources, filters.status);
}
