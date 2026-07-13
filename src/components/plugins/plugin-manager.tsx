"use client";

import * as React from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { formatDistanceToNow } from "date-fns";
import {
  BookOpen,
  Check,
  ChevronDown,
  Download,
  LifeBuoy,
  LoaderCircle,
  Package,
  Pencil,
  Plus,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { HelpTip } from "@/components/help-tip";
import { Badge, badgeVariants } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { detectSourceType, type DocsSourceType } from "@/lib/docs/source-type";
import {
  hasForumSource,
  isPluginStatusFilter,
  matchesPluginFilters,
  type PluginStatusFilter,
} from "@/lib/plugins/filters";
import { cn } from "@/lib/utils";

/** Radix Select forbids an empty-string item value, so "All" uses a sentinel. */
const ALL = "__all__";

const STATUS_FILTER_LABELS: Record<PluginStatusFilter, string> = {
  missing_docs: "Missing docs source",
  missing_forum: "Missing forum Q&A",
  never_ingested: "Never ingested",
};

export interface DocsSourceItem {
  id: string;
  url: string;
  type: string;
  status: string;
  pageCount: number;
  chunkCount: number;
  lastCrawledAt: string | null;
  error: string | null;
}

export interface PluginItem {
  id: string;
  name: string;
  wpOrgSlug: string | null;
  detectionKeywords: string[];
  brand: { id: string; name: string };
  chunkCount: number;
  docsSources: DocsSourceItem[];
}

export interface KeywordSuggestionItem {
  keyword: string;
  reason: string;
}

export interface KeywordSuggestion {
  add: KeywordSuggestionItem[];
  remove: KeywordSuggestionItem[];
  keep: string[];
}

export interface SuggestKeywordsResponse {
  suggestion: KeywordSuggestion;
  grounding: {
    wporg: boolean;
    threads: boolean;
    docs: boolean;
    /** Orphan Crisp segments (tags no plugin claims) were in the grounding. */
    orphanSegments: boolean;
  };
}

const SOURCE_STATUS_STYLES: Record<string, string> = {
  idle: "bg-zinc-100 text-zinc-600 dark:bg-zinc-500/15 dark:text-zinc-400",
  crawling:
    "bg-blue-100 text-blue-700 animate-pulse dark:bg-blue-500/15 dark:text-blue-400",
  completed:
    "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400",
  failed: "bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-400",
};

/** Display labels for docs-source types (falls back to the raw value). */
const SOURCE_TYPE_LABELS: Record<string, string> = {
  url: "URL",
  sitemap: "Sitemap",
  wporg_forum: "Forum Q&A",
};

/**
 * Labels for the auto-detected-type badge in the Add-source form — distinct
 * wording from SOURCE_TYPE_LABELS above (which decorates already-added
 * sources) since this badge is explaining a *guess* the user can override.
 */
const DETECTED_TYPE_BADGE_LABELS: Record<DocsSourceType, string> = {
  url: "Crawl",
  sitemap: "Sitemap",
  wporg_forum: "wp.org forum Q&A",
};

const SOURCE_TYPE_OPTIONS: Array<{ value: DocsSourceType; label: string }> = [
  { value: "url", label: "Crawl" },
  { value: "sitemap", label: "Sitemap" },
  { value: "wporg_forum", label: "wp.org forum Q&A" },
];

export function PluginManager({
  brands,
  plugins,
}: {
  brands: Array<{ id: string; name: string }>;
  plugins: PluginItem[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [showAddCard, setShowAddCard] = React.useState(false);

  const anyCrawling = plugins.some((plugin) =>
    plugin.docsSources.some((source) => source.status === "crawling")
  );

  // While any source is crawling, refresh the page data periodically so the
  // status badges and counts track the background ingest.
  React.useEffect(() => {
    if (!anyCrawling) return;
    const id = setInterval(() => router.refresh(), 3000);
    return () => clearInterval(id);
  }, [anyCrawling, router]);

  const brandFilter = searchParams.get("brandId");
  const rawStatusFilter = searchParams.get("status");
  const statusFilter = isPluginStatusFilter(rawStatusFilter)
    ? rawStatusFilter
    : null;
  const hasActiveFilter = Boolean(brandFilter) || Boolean(statusFilter);

  function setFilterParam(key: "brandId" | "status", value: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (value === ALL) params.delete(key);
    else params.set(key, value);
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }

  function clearFilters() {
    router.replace(pathname, { scroll: false });
  }

  const filteredPlugins = plugins.filter((plugin) =>
    matchesPluginFilters(plugin, { brandId: brandFilter, status: statusFilter })
  );

  return (
    <div className="space-y-6">
      {!showAddCard ? (
        <Button onClick={() => setShowAddCard(true)}>
          <Plus className="size-4" />
          Add a plugin
        </Button>
      ) : null}
      {showAddCard ? (
        <AddPluginCard
          brands={brands}
          onAdded={() => setShowAddCard(false)}
          onCancel={() => setShowAddCard(false)}
        />
      ) : null}

      {plugins.length > 0 ? (
        <div className="bg-card flex flex-wrap items-end gap-3 rounded-lg border p-3">
          <div className="space-y-1.5">
            <Label htmlFor="plugin-filter-brand" className="text-muted-foreground text-xs">
              Brand
            </Label>
            <Select
              value={brandFilter ?? ALL}
              onValueChange={(value) => setFilterParam("brandId", value)}
            >
              <SelectTrigger id="plugin-filter-brand" size="sm" className="w-48">
                <SelectValue placeholder="All brands" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All brands</SelectItem>
                {brands.map((brand) => (
                  <SelectItem key={brand.id} value={brand.id}>
                    {brand.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <div className="flex items-center gap-1">
              <Label htmlFor="plugin-filter-status" className="text-muted-foreground text-xs">
                Status
              </Label>
              <HelpTip subject="status filter">
                Missing docs source: no crawled documentation URL/sitemap yet.
                Missing forum Q&amp;A: no wp.org support-forum source yet.
                Never ingested: has at least one source, but none of them has
                ever produced a chunk (never successfully crawled).
              </HelpTip>
            </div>
            <Select
              value={statusFilter ?? ALL}
              onValueChange={(value) => setFilterParam("status", value)}
            >
              <SelectTrigger id="plugin-filter-status" size="sm" className="w-52">
                <SelectValue placeholder="All statuses" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All statuses</SelectItem>
                {Object.entries(STATUS_FILTER_LABELS).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {hasActiveFilter ? (
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground"
              onClick={clearFilters}
            >
              <X className="size-3.5" />
              Clear filters
            </Button>
          ) : null}
        </div>
      ) : null}

      {plugins.length === 0 ? (
        <div className="text-muted-foreground rounded-lg border border-dashed p-10 text-center text-sm">
          <Package className="mx-auto mb-2 size-6 opacity-60" />
          No plugins yet — add your products (FileBird, YayMail...) so chats
          and docs get tagged correctly.
        </div>
      ) : filteredPlugins.length === 0 ? (
        <div className="text-muted-foreground rounded-lg border border-dashed p-10 text-center text-sm">
          No plugins match these filters.
        </div>
      ) : (
        filteredPlugins.map((plugin) => (
          <PluginCard key={plugin.id} plugin={plugin} />
        ))
      )}
    </div>
  );
}

function AddPluginCard({
  brands,
  onAdded,
  onCancel,
}: {
  brands: Array<{ id: string; name: string }>;
  /** Called after a successful create — the caller collapses the card. */
  onAdded: () => void;
  onCancel: () => void;
}) {
  const router = useRouter();
  const [brandId, setBrandId] = React.useState("");
  const [name, setName] = React.useState("");
  const [keywords, setKeywords] = React.useState("");
  const [wpOrgSlug, setWpOrgSlug] = React.useState("");
  const [saving, setSaving] = React.useState(false);

  const createPlugin = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    try {
      const res = await fetch("/api/plugins", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          brandId,
          name: name.trim(),
          wpOrgSlug: wpOrgSlug.trim() || undefined,
          detectionKeywords: keywords
            .split(",")
            .map((k) => k.trim())
            .filter(Boolean),
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(body.error ?? "Failed to create plugin");
        return;
      }
      toast.success(`Plugin "${name.trim()}" added`);
      setName("");
      setKeywords("");
      setWpOrgSlug("");
      router.refresh();
      onAdded();
    } catch {
      toast.error("Failed to create plugin");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Add a plugin</CardTitle>
        <CardDescription>
          Detection keywords (comma-separated) tag chat chunks with this
          product — the plugin name always counts as a keyword.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          onSubmit={createPlugin}
          className="grid gap-3 sm:grid-cols-[1fr_1fr_1.4fr_1fr_auto]"
        >
          {/* flex/gap (not space-y) here — Radix's hidden native <select>
              (used for form fallback) sits after the trigger, and space-y's
              sibling-margin rule would apply to it too, inflating this
              cell's height a few px past the trigger's visible bottom and
              throwing off the grid row's height (and the Add button's
              items-end alignment) even though it's invisible. gap skips
              out-of-flow children, so it doesn't have this problem. */}
          <div className="flex flex-col gap-1.5">
            <Label>Brand</Label>
            <Select value={brandId} onValueChange={setBrandId}>
              <SelectTrigger>
                <SelectValue placeholder="Select brand" />
              </SelectTrigger>
              <SelectContent>
                {brands.map((brand) => (
                  <SelectItem key={brand.id} value={brand.id}>
                    {brand.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="plugin-name">Name</Label>
            <Input
              id="plugin-name"
              placeholder="FileBird"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
          </div>
          <div className="space-y-1.5">
            <div className="flex items-center gap-1">
              <Label htmlFor="plugin-keywords">Keywords</Label>
              <HelpTip
                subject="Keywords"
                example={
                  <>
                    Example: for FileBird, add: file bird, njt-filebird —
                    chats mentioning any of these get tagged as FileBird, so
                    the AI can tell which product a past conversation was
                    about.
                  </>
                }
              >
                Extra names that identify this product in chat conversations,
                comma-separated. The plugin name always counts on its own.
                Matching is case-insensitive and tolerates spaces.
              </HelpTip>
            </div>
            <Input
              id="plugin-keywords"
              placeholder="file bird, njt-filebird"
              value={keywords}
              onChange={(e) => setKeywords(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <div className="flex items-center gap-1">
              <Label htmlFor="plugin-wporg">wp.org slug</Label>
              <HelpTip example="wordpress.org/plugins/filebird → slug is filebird">
                The plugin&rsquo;s slug on wordpress.org/plugins/&lt;slug&gt;.
                Setting it unlocks watching the plugin&rsquo;s wp.org support
                forum and adding it as a Forum Q&amp;A docs source.
              </HelpTip>
            </div>
            <Input
              id="plugin-wporg"
              placeholder="filebird"
              value={wpOrgSlug}
              onChange={(e) => setWpOrgSlug(e.target.value)}
            />
          </div>
          <div className="flex items-end gap-2">
            <Button type="submit" disabled={saving || !brandId || !name}>
              {saving ? (
                <LoaderCircle className="size-4 animate-spin" />
              ) : (
                <Plus className="size-4" />
              )}
              Add
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={onCancel}
              disabled={saving}
            >
              Cancel
            </Button>
          </div>
        </form>
        {brands.length === 0 ? (
          <p className="text-muted-foreground mt-3 text-xs">
            Create a brand first on the Brands page.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function PluginCard({ plugin }: { plugin: PluginItem }) {
  const router = useRouter();
  const [sourceUrl, setSourceUrl] = React.useState("");
  // Auto-detected from the URL as the user types; null while the input is
  // empty (no badge shown). A manual pick from the override dropdown wins
  // over detection until the URL text changes again.
  const [typeOverride, setTypeOverride] = React.useState<DocsSourceType | null>(
    null
  );
  const detectedType = sourceUrl.trim()
    ? detectSourceType(sourceUrl.trim())
    : null;
  const effectiveType: DocsSourceType = typeOverride ?? detectedType ?? "url";
  const [busy, setBusy] = React.useState<string | null>(null);
  const [editingKeywords, setEditingKeywords] = React.useState(false);
  const [keywordsInput, setKeywordsInput] = React.useState("");
  const [suggestOpen, setSuggestOpen] = React.useState(false);
  const [suggestion, setSuggestion] = React.useState<SuggestKeywordsResponse | null>(
    null
  );
  const [checkedAdds, setCheckedAdds] = React.useState<Set<string>>(new Set());
  const [checkedRemoves, setCheckedRemoves] = React.useState<Set<string>>(new Set());
  // Matches the forum source by type OR by a wp.org forum listing URL (see
  // lib/plugins/filters), so a legacy "url"-typed forum row (healed to
  // "wporg_forum" only on its next ingest) still hides the "Add forum
  // source" button and avoids a duplicate.
  const pluginHasForumSource = hasForumSource(plugin.docsSources);

  const call = async (
    key: string,
    request: () => Promise<Response>,
    successMessage: string
  ) => {
    setBusy(key);
    try {
      const res = await request();
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(body.error ?? "Request failed");
        return false;
      }
      toast.success(successMessage);
      router.refresh();
      return true;
    } catch {
      toast.error("Request failed");
      return false;
    } finally {
      setBusy(null);
    }
  };

  const addSource = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const ok = await call(
      "add-source",
      () =>
        fetch("/api/docs/sources", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            pluginId: plugin.id,
            url: sourceUrl.trim(),
            type: effectiveType,
          }),
        }),
      "Docs source added — click Ingest to crawl it"
    );
    if (ok) {
      setSourceUrl("");
      setTypeOverride(null);
    }
  };

  const startEditingKeywords = () => {
    setKeywordsInput(plugin.detectionKeywords.join(", "));
    setEditingKeywords(true);
  };

  const cancelEditingKeywords = () => {
    setEditingKeywords(false);
  };

  const saveKeywords = async () => {
    const ok = await call(
      "edit-keywords",
      () =>
        fetch(`/api/plugins/${plugin.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            detectionKeywords: keywordsInput
              .split(",")
              .map((k) => k.trim())
              .filter(Boolean),
          }),
        }),
      "Keywords updated"
    );
    if (ok) setEditingKeywords(false);
  };

  const requestSuggestions = async () => {
    setBusy("suggest-keywords");
    try {
      const res = await fetch(`/api/plugins/${plugin.id}/suggest-keywords`, {
        method: "POST",
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(body.error ?? "Failed to generate keyword suggestions");
        return;
      }
      const result = body as SuggestKeywordsResponse;
      setSuggestion(result);
      // Additions default checked (opt-out), removals default unchecked
      // (opt-in) — conservative, since removing an existing keyword can stop
      // matching real conversations.
      setCheckedAdds(new Set(result.suggestion.add.map((item) => item.keyword)));
      setCheckedRemoves(new Set());
      setSuggestOpen(true);
    } catch {
      toast.error("Failed to generate keyword suggestions");
    } finally {
      setBusy(null);
    }
  };

  const toggleAdd = (keyword: string, checked: boolean) => {
    setCheckedAdds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(keyword);
      else next.delete(keyword);
      return next;
    });
  };

  const toggleRemove = (keyword: string, checked: boolean) => {
    setCheckedRemoves((prev) => {
      const next = new Set(prev);
      if (checked) next.add(keyword);
      else next.delete(keyword);
      return next;
    });
  };

  const applySuggestions = async () => {
    if (!suggestion) return;
    const removeLower = new Set(
      suggestion.suggestion.remove
        .filter((item) => checkedRemoves.has(item.keyword))
        .map((item) => item.keyword.toLowerCase())
    );
    const merged = [
      ...plugin.detectionKeywords.filter((k) => !removeLower.has(k.toLowerCase())),
      ...suggestion.suggestion.add
        .filter((item) => checkedAdds.has(item.keyword))
        .map((item) => item.keyword),
    ];
    const ok = await call(
      "suggest-apply",
      () =>
        fetch(`/api/plugins/${plugin.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ detectionKeywords: merged }),
        }),
      "Keywords updated"
    );
    if (ok) setSuggestOpen(false);
  };

  const groundingLabel = suggestion
    ? [
        suggestion.grounding.wporg && "wp.org listing",
        suggestion.grounding.threads && "recent support threads",
        suggestion.grounding.docs && "docs sources",
        suggestion.grounding.orphanSegments && "orphan segments",
      ]
        .filter(Boolean)
        .join(", ") || "plugin name only"
    : "";

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="text-base">{plugin.name}</CardTitle>
          <Badge variant="secondary">{plugin.brand.name}</Badge>
          {plugin.wpOrgSlug ? (
            // The wp.org slug, not a URL — a "wp.org/…" prefix read as a
            // (broken) link, so show it as a bare slug with the real plugin
            // page one click away.
            <Badge
              variant="outline"
              className="font-mono text-[11px]"
              title={`wordpress.org/plugins/${plugin.wpOrgSlug}`}
            >
              <a
                href={`https://wordpress.org/plugins/${plugin.wpOrgSlug}/`}
                target="_blank"
                rel="noreferrer"
                className="hover:underline"
              >
                /{plugin.wpOrgSlug}
              </a>
            </Badge>
          ) : null}
          <span className="text-muted-foreground ml-auto text-xs tabular-nums">
            {plugin.chunkCount} chunks
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="text-muted-foreground -mr-2 hover:text-red-600"
            title="Delete plugin"
            disabled={busy === "delete-plugin"}
            onClick={() => {
              if (
                window.confirm(
                  `Delete plugin "${plugin.name}"? Its ingested docs and doc chunks are removed.`
                )
              ) {
                void call(
                  "delete-plugin",
                  () => fetch(`/api/plugins/${plugin.id}`, { method: "DELETE" }),
                  `Plugin "${plugin.name}" deleted`
                );
              }
            }}
          >
            <Trash2 className="size-4" />
          </Button>
        </div>
        <CardDescription className="flex flex-wrap items-center gap-1">
          <span className="mr-1">Keywords:</span>
          {editingKeywords ? (
            <div className="flex min-w-56 flex-1 items-center gap-1.5">
              <Input
                autoFocus
                value={keywordsInput}
                onChange={(e) => setKeywordsInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void saveKeywords();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    cancelEditingKeywords();
                  }
                }}
                placeholder="file bird, njt-filebird"
                disabled={busy === "edit-keywords"}
                className="h-7 max-w-md text-xs"
              />
              <Button
                variant="ghost"
                size="icon"
                className="size-6 text-muted-foreground hover:text-foreground"
                title="Save keywords"
                disabled={busy === "edit-keywords"}
                onClick={() => void saveKeywords()}
              >
                {busy === "edit-keywords" ? (
                  <LoaderCircle className="size-3.5 animate-spin" />
                ) : (
                  <Check className="size-3.5" />
                )}
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="size-6 text-muted-foreground hover:text-foreground"
                title="Cancel"
                disabled={busy === "edit-keywords"}
                onClick={cancelEditingKeywords}
              >
                <X className="size-3.5" />
              </Button>
            </div>
          ) : (
            <>
              {plugin.detectionKeywords.length > 0 ? (
                plugin.detectionKeywords.map((keyword) => (
                  <Badge
                    key={keyword}
                    variant="outline"
                    className="px-1.5 py-0 text-[11px] font-normal"
                  >
                    {keyword}
                  </Badge>
                ))
              ) : (
                <span className="text-muted-foreground/70 italic">none</span>
              )}
              <Button
                variant="ghost"
                size="icon"
                className="size-5 text-muted-foreground hover:text-foreground"
                title="Edit keywords"
                onClick={startEditingKeywords}
              >
                <Pencil className="size-3" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="size-5 text-muted-foreground hover:text-foreground"
                title="AI suggest keywords"
                disabled={busy === "suggest-keywords"}
                onClick={() => void requestSuggestions()}
              >
                {busy === "suggest-keywords" ? (
                  <LoaderCircle className="size-3 animate-spin" />
                ) : (
                  <Sparkles className="size-3" />
                )}
              </Button>
            </>
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {plugin.docsSources.length > 0 ? (
          <div className="space-y-2">
            {plugin.docsSources.map((source) => (
              <div
                key={source.id}
                className="flex flex-wrap items-center gap-2 rounded-md border px-3 py-2"
              >
                {source.type === "wporg_forum" ? (
                  <LifeBuoy className="text-muted-foreground size-4 shrink-0" />
                ) : (
                  <BookOpen className="text-muted-foreground size-4 shrink-0" />
                )}
                <a
                  href={source.url}
                  target="_blank"
                  rel="noreferrer"
                  className="min-w-0 flex-1 truncate text-xs font-medium hover:underline"
                  title={source.url}
                >
                  {source.url}
                </a>
                <Badge variant="outline" className="text-[11px] uppercase">
                  {SOURCE_TYPE_LABELS[source.type] ?? source.type}
                </Badge>
                <Badge
                  className={cn(
                    "border-transparent capitalize",
                    SOURCE_STATUS_STYLES[source.status] ??
                      SOURCE_STATUS_STYLES.idle
                  )}
                >
                  {source.status}
                </Badge>
                <span className="text-muted-foreground text-xs tabular-nums">
                  {source.pageCount}{" "}
                  {source.type === "wporg_forum" ? "topics" : "pages"} ·{" "}
                  {source.chunkCount} chunks
                </span>
                {source.lastCrawledAt ? (
                  <span
                    className="text-muted-foreground text-xs"
                    suppressHydrationWarning
                  >
                    {formatDistanceToNow(new Date(source.lastCrawledAt), {
                      addSuffix: true,
                    })}
                  </span>
                ) : null}
                <div className="ml-auto flex items-center gap-1">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={
                      busy === `ingest-${source.id}` ||
                      source.status === "crawling"
                    }
                    onClick={() =>
                      void call(
                        `ingest-${source.id}`,
                        () =>
                          fetch(`/api/docs/sources/${source.id}/ingest`, {
                            method: "POST",
                          }),
                        "Ingest started in the background"
                      )
                    }
                  >
                    {source.status === "crawling" ? (
                      <LoaderCircle className="size-3.5 animate-spin" />
                    ) : (
                      <Download className="size-3.5" />
                    )}
                    Ingest
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="text-muted-foreground hover:text-red-600"
                    title="Remove docs source"
                    disabled={busy === `delete-${source.id}`}
                    onClick={() => {
                      if (
                        window.confirm(
                          "Remove this docs source and its ingested pages/chunks?"
                        )
                      ) {
                        void call(
                          `delete-${source.id}`,
                          () =>
                            fetch(`/api/docs/sources/${source.id}`, {
                              method: "DELETE",
                            }),
                          "Docs source removed"
                        );
                      }
                    }}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
                {source.error ? (
                  <p className="text-destructive w-full text-xs" title={source.error}>
                    {source.error}
                  </p>
                ) : null}
              </div>
            ))}
          </div>
        ) : (
          <p className="text-muted-foreground text-xs">
            No docs sources yet — add the plugin&apos;s documentation URL below.
          </p>
        )}

        <Separator />

        <form onSubmit={addSource} className="flex flex-wrap items-center gap-2">
          <Input
            placeholder="https://docs.example.com/filebird/"
            value={sourceUrl}
            onChange={(e) => {
              setSourceUrl(e.target.value);
              // A new URL invalidates any manual override from the previous
              // one — re-detect fresh each time the text changes.
              setTypeOverride(null);
            }}
            className="min-w-56 flex-1"
            type="url"
            required
          />
          {detectedType ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className={cn(
                    badgeVariants({ variant: "outline" }),
                    "cursor-pointer gap-1"
                  )}
                  title="Detected source type — click to override"
                >
                  {DETECTED_TYPE_BADGE_LABELS[effectiveType]}
                  <ChevronDown className="size-3" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="min-w-44">
                <DropdownMenuLabel>Source type</DropdownMenuLabel>
                {SOURCE_TYPE_OPTIONS.map((option) => (
                  <DropdownMenuItem
                    key={option.value}
                    onSelect={() => setTypeOverride(option.value)}
                  >
                    <Check
                      className={cn(
                        "size-3.5",
                        option.value === effectiveType
                          ? "opacity-100"
                          : "opacity-0"
                      )}
                    />
                    {option.label}
                    {option.value === detectedType ? (
                      <span className="text-muted-foreground ml-auto text-[10px]">
                        detected
                      </span>
                    ) : null}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
          <HelpTip subject="source type detection">
            The type is auto-detected from the URL: a wordpress.org
            support-forum link becomes a Forum Q&amp;A source, a URL ending
            in a sitemap file (e.g. sitemap.xml) becomes a Sitemap source,
            and anything else is crawled as a docs URL. Click the badge next
            to the input to override the detected type for this submission.
          </HelpTip>
          <Button
            type="submit"
            variant="outline"
            disabled={busy === "add-source" || !sourceUrl.trim()}
          >
            {busy === "add-source" ? (
              <LoaderCircle className="size-4 animate-spin" />
            ) : (
              <Plus className="size-4" />
            )}
            Add source
          </Button>
        </form>

        {plugin.wpOrgSlug && !pluginHasForumSource ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy === "add-forum"}
            onClick={() =>
              void call(
                "add-forum",
                () =>
                  fetch("/api/docs/sources", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      pluginId: plugin.id,
                      url: `https://wordpress.org/support/plugin/${plugin.wpOrgSlug}/`,
                      type: "wporg_forum",
                    }),
                  }),
                "Forum Q&A source added — click Ingest to import answered topics"
              )
            }
          >
            {busy === "add-forum" ? (
              <LoaderCircle className="size-3.5 animate-spin" />
            ) : (
              <LifeBuoy className="size-3.5" />
            )}
            Add wp.org forum Q&A source
          </Button>
        ) : null}
      </CardContent>

      <Dialog open={suggestOpen} onOpenChange={setSuggestOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>AI keyword suggestions — {plugin.name}</DialogTitle>
            <DialogDescription>
              Review before applying. Additions start checked, removals start
              unchecked — nothing changes until you hit Apply.
            </DialogDescription>
          </DialogHeader>
          {suggestion ? (
            <div className="space-y-4">
              {suggestion.suggestion.add.length === 0 &&
              suggestion.suggestion.remove.length === 0 ? (
                <p className="text-muted-foreground text-sm">
                  No changes suggested — current keywords look good.
                </p>
              ) : null}
              {suggestion.suggestion.add.length > 0 ? (
                <div className="space-y-1.5">
                  <p className="text-muted-foreground text-xs font-medium uppercase">
                    Add
                  </p>
                  {suggestion.suggestion.add.map((item) => (
                    <label
                      key={item.keyword}
                      className="flex items-start gap-2 text-sm"
                    >
                      <input
                        type="checkbox"
                        className="mt-0.5 size-3.5 shrink-0 rounded border-input"
                        checked={checkedAdds.has(item.keyword)}
                        onChange={(e) => toggleAdd(item.keyword, e.target.checked)}
                      />
                      <span>
                        <span className="font-mono text-xs">{item.keyword}</span>
                        {item.reason ? (
                          <span className="text-muted-foreground"> — {item.reason}</span>
                        ) : null}
                      </span>
                    </label>
                  ))}
                </div>
              ) : null}
              {suggestion.suggestion.remove.length > 0 ? (
                <div className="space-y-1.5">
                  <p className="text-muted-foreground text-xs font-medium uppercase">
                    Remove
                  </p>
                  {suggestion.suggestion.remove.map((item) => (
                    <label
                      key={item.keyword}
                      className="flex items-start gap-2 text-sm"
                    >
                      <input
                        type="checkbox"
                        className="mt-0.5 size-3.5 shrink-0 rounded border-input"
                        checked={checkedRemoves.has(item.keyword)}
                        onChange={(e) => toggleRemove(item.keyword, e.target.checked)}
                      />
                      <span>
                        <span className="font-mono text-xs">{item.keyword}</span>
                        {item.reason ? (
                          <span className="text-muted-foreground"> — {item.reason}</span>
                        ) : null}
                      </span>
                    </label>
                  ))}
                </div>
              ) : null}
              <p className="text-muted-foreground text-xs">
                Grounded on: {groundingLabel}
              </p>
            </div>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              disabled={busy === "suggest-apply"}
              onClick={() => setSuggestOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              disabled={busy === "suggest-apply" || !suggestion}
              onClick={() => void applySuggestions()}
            >
              {busy === "suggest-apply" ? (
                <LoaderCircle className="size-4 animate-spin" />
              ) : null}
              Apply
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
