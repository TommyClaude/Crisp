/**
 * Lightweight product/plugin detection for support conversations.
 *
 * Detection definitions normally come from the Plugin table (see
 * ./product-defs.ts) so new plugins are added in the UI without code
 * changes; the hardcoded list below is the fallback for a fresh install.
 * This module is pure (no DB access) and safe to import from client code.
 */

export const KNOWN_PRODUCTS = [
  "FileBird",
  "YayMail",
  "YayCurrency",
  "YaySMTP",
  "Brandy",
  "YayCommerce",
  "WooCommerce",
  "WordPress",
] as const;

export interface ProductDef {
  name: string;
  patterns: RegExp[];
  /** Platforms (WooCommerce/WordPress) only win when no plugin matched. */
  isPlatform: boolean;
}

/** Escape a keyword and turn it into a word-boundary, space-tolerant regex. */
export function keywordPattern(keyword: string): RegExp {
  const escaped = keyword
    .trim()
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    // "YayMail" should also match "Yay Mail"; spaces match optional space.
    .replace(/\s+/g, "\\s?");
  return new RegExp(`\\b${escaped}\\b`, "i");
}

const PLATFORM_NAMES = new Set(["WooCommerce", "WordPress"]);

/** Build detection definitions from Plugin rows (name + keywords). */
export function defsFromPlugins(
  plugins: Array<{ name: string; detectionKeywords: string[] }>
): ProductDef[] {
  return plugins.map((plugin) => ({
    name: plugin.name,
    patterns: [
      keywordPattern(plugin.name),
      ...plugin.detectionKeywords
        .filter((k) => k.trim().length > 1)
        .map(keywordPattern),
    ],
    isPlatform: PLATFORM_NAMES.has(plugin.name),
  }));
}

// Order matters: specific plugins first, platforms last (used as tiebreaker).
export const DEFAULT_PRODUCT_DEFS: ProductDef[] = [
  { name: "FileBird", patterns: [/\bfile\s?bird\b/i, /\bnjt-filebird\b/i], isPlatform: false },
  { name: "YayMail", patterns: [/\byay\s?mail\b/i], isPlatform: false },
  { name: "YayCurrency", patterns: [/\byay\s?currency\b/i], isPlatform: false },
  { name: "YaySMTP", patterns: [/\byay\s?smtp\b/i], isPlatform: false },
  { name: "Brandy", patterns: [/\bbrandy\b/i], isPlatform: false },
  { name: "YayCommerce", patterns: [/\byay\s?commerce\b/i], isPlatform: false },
  {
    name: "WooCommerce",
    patterns: [/\bwoo\s?commerce\b/i, /\bwoo\b(?=.{0,24}\b(shop|store|order|checkout|product)\b)/i],
    isPlatform: true,
  },
  {
    name: "WordPress",
    patterns: [/\bword\s?press\b/i, /\bwp-(admin|content|config|cli)\b/i],
    isPlatform: true,
  },
];

/** Count keyword hits per product in the given text. */
export function detectProducts(
  text: string,
  defs: ProductDef[] = DEFAULT_PRODUCT_DEFS
): Map<string, number> {
  const hits = new Map<string, number>();
  for (const { name, patterns } of defs) {
    let count = 0;
    for (const pattern of patterns) {
      const flags = pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g";
      const matches = text.match(new RegExp(pattern.source, flags));
      count += matches?.length ?? 0;
    }
    if (count > 0) hits.set(name, count);
  }
  return hits;
}

/**
 * Pick the primary product for a conversation. Specific plugins beat
 * platform-level matches (WooCommerce/WordPress) regardless of hit count.
 * Tags (Crisp segments) that name a product take priority over text hits.
 */
export function detectPrimaryProduct(
  text: string,
  tags: string[] = [],
  defs: ProductDef[] = DEFAULT_PRODUCT_DEFS
): string | null {
  for (const tag of tags) {
    for (const { name, patterns } of defs) {
      if (patterns.some((p) => p.test(tag))) return name;
    }
  }

  const hits = detectProducts(text, defs);
  if (hits.size === 0) return null;

  const isPlatform = (name: string) =>
    defs.find((d) => d.name === name)?.isPlatform ?? false;

  let best: string | null = null;
  let bestCount = -1;
  for (const [name, count] of hits) {
    const bestIsPlatform = best !== null && isPlatform(best);
    // A specific plugin always beats a platform.
    if (best !== null && !bestIsPlatform && isPlatform(name)) continue;
    if (best === null || (bestIsPlatform && !isPlatform(name)) || count > bestCount) {
      best = name;
      bestCount = count;
    }
  }
  return best;
}
