/**
 * Lightweight product/plugin detection for support conversations.
 * Detection is keyword-based; the most specific product wins so that a
 * FileBird question that happens to mention WordPress is tagged "FileBird".
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

export type KnownProduct = (typeof KNOWN_PRODUCTS)[number];

// Order matters: specific plugins first, platforms last (used as tiebreaker).
const PRODUCT_PATTERNS: Array<{ product: KnownProduct; patterns: RegExp[] }> = [
  { product: "FileBird", patterns: [/\bfile\s?bird\b/i, /\bnjt-filebird\b/i] },
  { product: "YayMail", patterns: [/\byay\s?mail\b/i] },
  { product: "YayCurrency", patterns: [/\byay\s?currency\b/i] },
  { product: "YaySMTP", patterns: [/\byay\s?smtp\b/i] },
  { product: "Brandy", patterns: [/\bbrandy\b/i] },
  { product: "YayCommerce", patterns: [/\byay\s?commerce\b/i] },
  {
    product: "WooCommerce",
    patterns: [/\bwoo\s?commerce\b/i, /\bwoo\b(?=.{0,24}\b(shop|store|order|checkout|product)\b)/i],
  },
  {
    product: "WordPress",
    patterns: [/\bword\s?press\b/i, /\bwp-(admin|content|config|cli)\b/i],
  },
];

// Platforms only win when no specific plugin matched.
const PLATFORM_PRODUCTS: ReadonlySet<KnownProduct> = new Set([
  "WooCommerce",
  "WordPress",
]);

/** Count keyword hits per product in the given text. */
export function detectProducts(text: string): Map<KnownProduct, number> {
  const hits = new Map<KnownProduct, number>();
  for (const { product, patterns } of PRODUCT_PATTERNS) {
    let count = 0;
    for (const pattern of patterns) {
      const matches = text.match(new RegExp(pattern.source, pattern.flags + "g"));
      count += matches?.length ?? 0;
    }
    if (count > 0) hits.set(product, count);
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
  tags: string[] = []
): KnownProduct | null {
  for (const tag of tags) {
    for (const { product, patterns } of PRODUCT_PATTERNS) {
      if (patterns.some((p) => p.test(tag))) return product;
    }
  }

  const hits = detectProducts(text);
  if (hits.size === 0) return null;

  let best: KnownProduct | null = null;
  let bestCount = -1;
  for (const [product, count] of hits) {
    const isPlatform = PLATFORM_PRODUCTS.has(product);
    const bestIsPlatform = best !== null && PLATFORM_PRODUCTS.has(best);
    // A specific plugin always beats a platform.
    if (best !== null && !bestIsPlatform && isPlatform) continue;
    if (best === null || (bestIsPlatform && !isPlatform) || count > bestCount) {
      best = product;
      bestCount = count;
    }
  }
  return best;
}
