import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { resolveProvider, generateDraftFor } from "@/lib/suggest/llm";
import { htmlToText } from "@/lib/docs/crawler";
import {
  getOrphanSegments,
  type OrphanSegment,
} from "@/lib/rag/orphan-segments";

export const dynamic = "force-dynamic";
// A single LLM call (with at most one retry on invalid JSON) plus a
// best-effort wp.org fetch — one provider round-trip can legitimately take a
// while under load, mirror the other suggest routes' generous ceiling.
export const maxDuration = 120;

const WPORG_FETCH_TIMEOUT_MS = 10_000;
/** Truncate the wp.org "description" section (often long, HTML-heavy). */
const WPORG_DESCRIPTION_MAX_CHARS = 2000;
/** Most recent support-thread titles fed to the model as grounding. */
const MAX_THREAD_TITLES = 20;
/** Top orphan Crisp segments (tags no plugin claims) fed as grounding. */
const MAX_ORPHAN_SEGMENTS = 15;

/**
 * POST /api/plugins/:id/suggest-keywords
 *
 * Reviews a plugin's detection keywords (see src/lib/rag/products.ts for the
 * exact matching semantics) and asks an LLM to suggest additions/removals,
 * grounded in best-effort context: the plugin's wordpress.org listing, its
 * recent support-thread titles, its known docs sources, and the top orphan
 * Crisp segments (conversation tags no plugin currently claims — the same
 * data behind the /rag "Orphan segments" panel, so the AI can propose a
 * keyword that would claim a tag that plausibly belongs to this plugin).
 * Human-in-the-loop by design — this route only SUGGESTS, it never mutates
 * the Plugin row. Applying a suggestion goes through the existing PATCH
 * /api/plugins/:id.
 */

const suggestionItemSchema = z.object({
  keyword: z.string().trim().min(1),
  reason: z.string().trim().default(""),
});

const suggestionSchema = z.object({
  add: z.array(suggestionItemSchema).default([]),
  remove: z.array(suggestionItemSchema).default([]),
  keep: z.array(z.string()).default([]),
});

type Suggestion = z.infer<typeof suggestionSchema>;

/**
 * Pull a JSON object out of raw LLM text. Models sometimes wrap the JSON in
 * a markdown code fence or add a stray sentence around it even when asked
 * for strict JSON, so this tries a straight parse first and falls back to
 * slicing between the outermost braces before giving up.
 */
function extractJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through to brace-slicing below
  }
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first !== -1 && last > first) {
    return JSON.parse(trimmed.slice(first, last + 1));
  }
  throw new Error("No JSON object found in LLM response");
}

function parseSuggestion(text: string): Suggestion {
  const json = extractJson(text);
  const parsed = suggestionSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`Suggestion JSON failed validation: ${parsed.error.message}`);
  }
  return parsed.data;
}

/**
 * Best-effort wp.org plugin listing lookup: name, short description, and the
 * "description" section stripped of HTML and truncated. Returns null on ANY
 * failure (timeout, network error, 404, bad JSON) — the caller continues
 * without this grounding rather than failing the whole request. wordpress.org
 * is unreachable from CI/sandboxes (proxy 403s it), so this path is only ever
 * exercised for real on a deployment with outbound internet access; tests
 * stub `fetch` instead of hitting it live.
 */
async function fetchWpOrgListing(
  slug: string
): Promise<{ name: string; shortDescription: string; description: string } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WPORG_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(
      `https://api.wordpress.org/plugins/info/1.0/${encodeURIComponent(slug)}.json`,
      { signal: controller.signal, cache: "no-store" }
    );
    if (!response.ok) return null;
    const data = await response.json();
    if (!data || typeof data !== "object") return null;
    const rawDescription =
      typeof data.sections?.description === "string" ? data.sections.description : "";
    return {
      name: typeof data.name === "string" ? data.name : "",
      shortDescription:
        typeof data.short_description === "string" ? data.short_description : "",
      description: htmlToText(rawDescription).slice(0, WPORG_DESCRIPTION_MAX_CHARS),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const SYSTEM_PROMPT = `You are helping curate "detection keywords" for a WordPress plugin support tool. Detection keywords tag incoming support chat messages with the plugin they are about, so support staff (and an AI assistant) can tell which product a conversation concerns.

Matching rules you MUST respect when suggesting keywords:
- The plugin's NAME always auto-matches on its own — never suggest adding it again.
- Matching is case-insensitive and word-boundary (a keyword must appear as a whole word, not as a substring of a longer word).
- Spaces inside a keyword become OPTIONAL when matching, so "Yay Mail" and "YayMail" match the same text — you never need both forms.
- Hyphens are LITERAL, NOT equivalent to spaces or removed: "multi-currency" will NOT match "multi currency" in the text, and vice versa. If a spaced and a hyphenated (or slug-style) variant both occur in the wild, suggest them as separate keywords.
- Keywords of length 1 or shorter are dropped entirely by the system — never suggest single characters.
- This is a SHARED support inbox used across MANY different plugins from the same company. A single generic word (e.g. "currency", "email", "folder", "smtp", "sync", "order") causes cross-plugin false positives by matching conversations that are actually about a different plugin. Only suggest keywords that are distinctive to THIS plugin: its own feature names, slugs, common misspellings/variants of its own name, or terms unlikely to appear when discussing other plugins or WordPress/WooCommerce in general.

Extra grounding you may receive, and how to use it:
- The plugin's wordpress.org SLUG is a strong hint even on its own: split it on hyphens and ignore generic tokens (wp, lite, pro, plugin, woo, page, form) — the remaining tokens are strong candidate keywords, especially when the display name omits the colloquial product name (e.g. a plugin named "WP Chat App" with slug "wp-whatsapp": customers say "whatsapp", so "whatsapp" is a strong candidate keyword).
- ORPHAN SEGMENTS are Crisp conversation tags that currently match NO plugin's name or keywords, listed with how many conversations carry each. If an orphan tag plausibly refers to THIS plugin (a colloquial product name, a feature name, a lite/pro variant), propose a keyword that would claim it — minding the matching rules above (hyphens literal, word-boundary, spaces optional, so the keyword must actually match the tag text as written). The reason for such an addition MUST cite the claimed tag and its conversation count, e.g. "claims orphan segment 'whatsapp lite' (6 conversations)". Never claim a tag that more plausibly belongs to a different plugin or to WordPress/WooCommerce in general.

Respond with STRICT JSON ONLY — no markdown code fences, no commentary before or after — matching exactly this shape:
{"add": [{"keyword": "...", "reason": "..."}], "remove": [{"keyword": "...", "reason": "..."}], "keep": ["..."]}

- "add": new keywords worth adding, each with a short one-sentence reason.
- "remove": keywords from the CURRENT KEYWORDS list that are too generic, redundant with the name, or risk cross-plugin false positives — "remove" may ONLY reference keywords that are in the current list you were given, each with a short one-sentence reason.
- "keep": current keywords you reviewed and consider still good as-is (no reason needed).
- If nothing needs to change, return empty "add"/"remove" arrays and "keep" listing the current keywords.`;

function buildUserPrompt(
  plugin: { name: string; wpOrgSlug: string | null; detectionKeywords: string[] },
  grounding: {
    wporg: { name: string; shortDescription: string; description: string } | null;
    threadTitles: string[];
    docsSources: Array<{ url: string; type: string }>;
    orphanSegments: OrphanSegment[];
  }
): string {
  const lines: string[] = [
    `Plugin name: ${plugin.name}`,
    // The slug goes in explicitly (not only via the wp.org listing fetch) so
    // its token hints survive a failed/skipped wp.org lookup.
    plugin.wpOrgSlug ? `Plugin wp.org slug: ${plugin.wpOrgSlug}` : "",
    `Current detection keywords: ${
      plugin.detectionKeywords.length ? plugin.detectionKeywords.join(", ") : "(none)"
    }`,
  ];

  if (grounding.wporg) {
    lines.push(
      "",
      "=== wordpress.org plugin listing ===",
      `Listed name: ${grounding.wporg.name || "(unknown)"}`,
      grounding.wporg.shortDescription
        ? `Short description: ${grounding.wporg.shortDescription}`
        : "",
      grounding.wporg.description ? `Description:\n${grounding.wporg.description}` : ""
    );
  }

  if (grounding.threadTitles.length > 0) {
    lines.push(
      "",
      "=== Recent support thread titles for this plugin ===",
      grounding.threadTitles.map((title) => `- ${title}`).join("\n")
    );
  }

  if (grounding.docsSources.length > 0) {
    lines.push(
      "",
      "=== Known docs sources for this plugin ===",
      grounding.docsSources.map((source) => `- (${source.type}) ${source.url}`).join("\n")
    );
  }

  if (grounding.orphanSegments.length > 0) {
    lines.push(
      "",
      "=== Orphan Crisp segments (conversation tags matching NO plugin today) ===",
      grounding.orphanSegments
        .map((segment) => `- "${segment.tag}" (${segment.count} conversations)`)
        .join("\n")
    );
  }

  lines.push("", "Review the current keywords and suggest improvements now.");
  // Keep the "" spacers — they render as the blank lines separating sections.
  return lines.join("\n");
}

const RETRY_NUDGE =
  "\n\nYour previous response could not be parsed as valid JSON. Return ONLY a single valid JSON object matching the exact shape requested above — no markdown code fences, no explanation, no trailing text.";

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const provider = resolveProvider();
  if (!provider) {
    return NextResponse.json(
      {
        error:
          "No LLM provider configured — set ANTHROPIC_API_KEY or OPENAI_API_KEY (see SUGGESTER_PROVIDER) to enable AI keyword suggestions",
      },
      { status: 503 }
    );
  }

  const plugin = await prisma.plugin.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      wpOrgSlug: true,
      detectionKeywords: true,
      docsSources: { select: { url: true, type: true }, take: 10 },
      supportThreads: {
        select: { title: true },
        orderBy: { fetchedAt: "desc" },
        take: MAX_THREAD_TITLES,
      },
    },
  });
  if (!plugin) {
    return NextResponse.json({ error: "Plugin not found" }, { status: 404 });
  }

  // Grounding is gathered best-effort: wp.org can fail (rate limit, network,
  // unreachable sandbox) and the orphan-segment query can fail without ever
  // failing this route.
  const wporgListing = plugin.wpOrgSlug ? await fetchWpOrgListing(plugin.wpOrgSlug) : null;
  const threadTitles = plugin.supportThreads.map((thread) => thread.title);
  let orphanSegments: OrphanSegment[] = [];
  try {
    orphanSegments = await getOrphanSegments(MAX_ORPHAN_SEGMENTS);
  } catch (error) {
    console.error(`Orphan-segment grounding failed for plugin ${id}:`, error);
  }
  const grounding = {
    wporg: wporgListing !== null,
    threads: threadTitles.length > 0,
    docs: plugin.docsSources.length > 0,
    orphanSegments: orphanSegments.length > 0,
  };

  const userPrompt = buildUserPrompt(
    {
      name: plugin.name,
      wpOrgSlug: plugin.wpOrgSlug,
      detectionKeywords: plugin.detectionKeywords,
    },
    {
      wporg: wporgListing,
      threadTitles,
      docsSources: plugin.docsSources,
      orphanSegments,
    }
  );

  async function attempt(prompt: string): Promise<Suggestion> {
    const draft = await generateDraftFor(provider!, SYSTEM_PROMPT, prompt);
    return parseSuggestion(draft.text);
  }

  let suggestion: Suggestion;
  try {
    suggestion = await attempt(userPrompt);
  } catch (firstError) {
    console.error(`Keyword suggestion (attempt 1) failed for plugin ${id}:`, firstError);
    try {
      suggestion = await attempt(userPrompt + RETRY_NUDGE);
    } catch (secondError) {
      console.error(`Keyword suggestion (attempt 2) failed for plugin ${id}:`, secondError);
      return NextResponse.json(
        { error: "The AI did not return usable keyword suggestions — please try again" },
        { status: 502 }
      );
    }
  }

  // Never trust the model's echo of the keyword lists — filter both sides:
  // "remove" may only reference keywords actually on the plugin, and "add"
  // must drop anything that would be useless or hostile downstream: blanks,
  // keywords longer than the PATCH schema's max(100) cap (one oversized item
  // would make the whole Apply request fail atomically with a generic error),
  // duplicates of existing keywords or of the plugin name (both already
  // auto-match — suggesting them back just confuses the human reviewer), and
  // duplicates within the add list itself.
  const currentLower = new Set(plugin.detectionKeywords.map((k) => k.toLowerCase()));
  const remove = suggestion.remove.filter((item) => currentLower.has(item.keyword.toLowerCase()));
  const seenAdds = new Set<string>();
  const add = suggestion.add.filter((item) => {
    const keyword = item.keyword.trim();
    const lower = keyword.toLowerCase();
    if (keyword.length < 2 || keyword.length > 100) return false;
    if (currentLower.has(lower)) return false;
    if (lower === plugin.name.toLowerCase()) return false;
    if (seenAdds.has(lower)) return false;
    seenAdds.add(lower);
    return true;
  });

  return NextResponse.json({
    suggestion: { add, remove, keep: suggestion.keep },
    grounding,
  });
}
