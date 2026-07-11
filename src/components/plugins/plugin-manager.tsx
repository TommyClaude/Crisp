"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { formatDistanceToNow } from "date-fns";
import {
  BookOpen,
  Download,
  LifeBuoy,
  LoaderCircle,
  Package,
  Plus,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
import { cn } from "@/lib/utils";

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

export function PluginManager({
  brands,
  plugins,
}: {
  brands: Array<{ id: string; name: string }>;
  plugins: PluginItem[];
}) {
  const router = useRouter();
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

  return (
    <div className="space-y-6">
      <AddPluginCard brands={brands} />
      {plugins.length === 0 ? (
        <div className="text-muted-foreground rounded-lg border border-dashed p-10 text-center text-sm">
          <Package className="mx-auto mb-2 size-6 opacity-60" />
          No plugins yet — add your products (FileBird, YayMail...) so chats
          and docs get tagged correctly.
        </div>
      ) : (
        plugins.map((plugin) => <PluginCard key={plugin.id} plugin={plugin} />)
      )}
    </div>
  );
}

function AddPluginCard({ brands }: { brands: Array<{ id: string; name: string }> }) {
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
          <div className="space-y-1.5">
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
            <Label htmlFor="plugin-keywords">Keywords</Label>
            <Input
              id="plugin-keywords"
              placeholder="file bird, njt-filebird"
              value={keywords}
              onChange={(e) => setKeywords(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="plugin-wporg">wp.org slug</Label>
            <Input
              id="plugin-wporg"
              placeholder="filebird"
              value={wpOrgSlug}
              onChange={(e) => setWpOrgSlug(e.target.value)}
            />
          </div>
          <div className="flex items-end">
            <Button type="submit" disabled={saving || !brandId || !name}>
              {saving ? (
                <LoaderCircle className="size-4 animate-spin" />
              ) : (
                <Plus className="size-4" />
              )}
              Add
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
  const [sourceType, setSourceType] = React.useState<
    "url" | "sitemap" | "wporg_forum"
  >("url");
  const [busy, setBusy] = React.useState<string | null>(null);
  // Match the forum source by type OR by a wp.org forum listing URL, so a
  // legacy "url"-typed forum row (healed to "wporg_forum" only on its next
  // ingest) still hides the "Add forum source" button and avoids a duplicate.
  const hasForumSource = plugin.docsSources.some(
    (source) =>
      source.type === "wporg_forum" ||
      /\/\/(?:[^/]*\.)?wordpress\.org\/support\/plugin\//i.test(source.url)
  );

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
            type: sourceType,
          }),
        }),
      "Docs source added — click Ingest to crawl it"
    );
    if (ok) setSourceUrl("");
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="text-base">{plugin.name}</CardTitle>
          <Badge variant="secondary">{plugin.brand.name}</Badge>
          {plugin.wpOrgSlug ? (
            <Badge variant="outline" className="font-mono text-[11px]">
              wp.org/{plugin.wpOrgSlug}
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
        {plugin.detectionKeywords.length > 0 ? (
          <CardDescription className="flex flex-wrap items-center gap-1">
            <span className="mr-1">Keywords:</span>
            {plugin.detectionKeywords.map((keyword) => (
              <Badge
                key={keyword}
                variant="outline"
                className="px-1.5 py-0 text-[11px] font-normal"
              >
                {keyword}
              </Badge>
            ))}
          </CardDescription>
        ) : null}
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
                  {source.type === "wporg_forum" ? "threads" : "pages"} ·{" "}
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
            onChange={(e) => setSourceUrl(e.target.value)}
            className="min-w-56 flex-1"
            type="url"
            required
          />
          <Select
            value={sourceType}
            onValueChange={(v) =>
              setSourceType(v as "url" | "sitemap" | "wporg_forum")
            }
          >
            <SelectTrigger className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="url">Crawl URL</SelectItem>
              <SelectItem value="sitemap">Sitemap</SelectItem>
              <SelectItem value="wporg_forum">wp.org forum</SelectItem>
            </SelectContent>
          </Select>
          <Button
            type="submit"
            variant="outline"
            disabled={busy === "add-source" || !sourceUrl}
          >
            {busy === "add-source" ? (
              <LoaderCircle className="size-4 animate-spin" />
            ) : (
              <Plus className="size-4" />
            )}
            Add source
          </Button>
        </form>

        {plugin.wpOrgSlug && !hasForumSource ? (
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
                "Forum Q&A source added — click Ingest to import answered threads"
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
    </Card>
  );
}
