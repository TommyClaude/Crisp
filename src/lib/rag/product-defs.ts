import { prisma } from "@/lib/db";
import {
  DEFAULT_PRODUCT_DEFS,
  defsFromPlugins,
  type ProductDef,
} from "./products";

/**
 * Server-side loader for product-detection definitions. Reads the Plugin
 * table (managed in the /plugins UI) and falls back to the hardcoded list
 * when no plugins are configured yet. Cached briefly so chunk rebuilds don't
 * hit the DB once per conversation.
 */

const CACHE_TTL_MS = 60_000;

let cache: { defs: ProductDef[]; loadedAt: number } | null = null;

export async function getProductDefinitions(): Promise<ProductDef[]> {
  if (cache && Date.now() - cache.loadedAt < CACHE_TTL_MS) return cache.defs;
  try {
    const plugins = await prisma.plugin.findMany({
      select: { name: true, detectionKeywords: true },
      orderBy: { createdAt: "asc" },
    });
    const defs =
      plugins.length > 0 ? defsFromPlugins(plugins) : DEFAULT_PRODUCT_DEFS;
    cache = { defs, loadedAt: Date.now() };
    return defs;
  } catch (error) {
    console.error("Failed to load product definitions, using defaults:", error);
    return DEFAULT_PRODUCT_DEFS;
  }
}

/** Invalidate the cache after plugin create/update/delete. */
export function invalidateProductDefinitions(): void {
  cache = null;
}
