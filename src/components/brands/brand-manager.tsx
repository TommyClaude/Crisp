"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  Building2,
  CheckCircle2,
  Globe,
  LoaderCircle,
  MessageSquareText,
  PackagePlus,
  Plug,
  Plus,
  Trash2,
  XCircle,
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
import { Textarea } from "@/components/ui/textarea";

export interface BrandItem {
  id: string;
  name: string;
  crispWebsiteId: string;
  wpProfileSlug: string | null;
  /** Free-text house-style notes fed into the AI reply-drafting prompts. */
  replyStyle: string | null;
  pluginCount: number;
  conversationCount: number;
}

export function BrandManager({ brands }: { brands: BrandItem[] }) {
  const router = useRouter();
  const [name, setName] = React.useState("");
  const [websiteId, setWebsiteId] = React.useState("");
  const [wpProfile, setWpProfile] = React.useState("");
  const [saving, setSaving] = React.useState(false);

  const createBrand = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    try {
      const res = await fetch("/api/brands", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          crispWebsiteId: websiteId.trim(),
          wpProfileSlug: wpProfile.trim() || undefined,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(body.error ?? "Failed to create brand");
        return;
      }
      toast.success(`Brand "${name.trim()}" created`, {
        description:
          body.adoptedConversations > 0
            ? `${body.adoptedConversations} previously synced conversations linked.`
            : undefined,
      });
      setName("");
      setWebsiteId("");
      setWpProfile("");
      router.refresh();
    } catch {
      toast.error("Failed to create brand");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Add a brand</CardTitle>
          <CardDescription>
            The website ID is in the Crisp app URL:
            app.crisp.chat/website/<span className="font-mono">&lt;website-id&gt;</span>/inbox.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={createBrand} className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-[1fr_1.4fr_1fr_auto]">
              <div className="space-y-1.5">
                <Label htmlFor="brand-name">Name</Label>
                <Input
                  id="brand-name"
                  placeholder="YayCommerce"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="brand-website-id">Crisp website ID</Label>
                <Input
                  id="brand-website-id"
                  placeholder="00000000-0000-0000-0000-000000000000"
                  value={websiteId}
                  onChange={(e) => setWebsiteId(e.target.value)}
                  className="font-mono text-xs"
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="brand-wp-profile">wp.org profile (optional)</Label>
                <Input
                  id="brand-wp-profile"
                  placeholder="ninjateam"
                  value={wpProfile}
                  onChange={(e) => setWpProfile(e.target.value)}
                  className="font-mono text-xs"
                />
              </div>
              <div className="flex items-end">
                <Button type="submit" disabled={saving || !name || !websiteId}>
                  {saving ? (
                    <LoaderCircle className="size-4 animate-spin" />
                  ) : (
                    <Plus className="size-4" />
                  )}
                  Add brand
                </Button>
              </div>
            </div>
            <p className="text-muted-foreground text-xs">
              Brands authenticate with the global CRISP_IDENTIFIER/CRISP_KEY
              from .env — a Crisp Marketplace plugin production token, so the
              plugin must be installed on each brand&rsquo;s workspace.
            </p>
          </form>
        </CardContent>
      </Card>

      {brands.length === 0 ? (
        <div className="text-muted-foreground rounded-lg border border-dashed p-10 text-center text-sm">
          <Building2 className="mx-auto mb-2 size-6 opacity-60" />
          No brands yet — add one per Crisp website to start syncing.
        </div>
      ) : (
        <div className="space-y-3">
          {brands.map((brand) => (
            <BrandRow key={brand.id} brand={brand} />
          ))}
        </div>
      )}
    </div>
  );
}

function BrandRow({ brand }: { brand: BrandItem }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [editingProfile, setEditingProfile] = React.useState(false);
  const [profile, setProfile] = React.useState(brand.wpProfileSlug ?? "");
  const [editingStyle, setEditingStyle] = React.useState(false);
  const [style, setStyle] = React.useState(brand.replyStyle ?? "");
  const [testResult, setTestResult] = React.useState<{
    ok: boolean;
    message: string;
  } | null>(null);

  const deleteBrand = async () => {
    if (
      !window.confirm(
        `Delete brand "${brand.name}"? Its plugins and ingested docs are removed; conversations are kept.`
      )
    ) {
      return;
    }
    setBusy("delete");
    try {
      const res = await fetch(`/api/brands/${brand.id}`, { method: "DELETE" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(body.error ?? "Failed to delete brand");
        return;
      }
      toast.success(`Brand "${brand.name}" deleted`);
      router.refresh();
    } catch {
      toast.error("Failed to delete brand");
    } finally {
      setBusy(null);
    }
  };

  const testConnection = async () => {
    setBusy("test");
    setTestResult(null);
    try {
      const res = await fetch(`/api/brands/${brand.id}/test`, {
        method: "POST",
      });
      const body = await res.json().catch(() => ({}));
      if (body.ok) {
        setTestResult({
          ok: true,
          message: `Connected — ${body.sampleCount} conversation(s) on page 1.`,
        });
      } else {
        setTestResult({
          ok: false,
          message: body.error ?? "Connection failed",
        });
      }
    } catch {
      setTestResult({ ok: false, message: "Connection failed" });
    } finally {
      setBusy(null);
    }
  };

  const saveProfile = async (clear = false) => {
    setBusy("profile");
    try {
      const res = await fetch(`/api/brands/${brand.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wpProfileSlug: clear ? "" : profile.trim() }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(body.error ?? "Failed to save wp.org profile");
        return;
      }
      toast.success(clear ? "wp.org profile cleared" : "wp.org profile saved");
      setEditingProfile(false);
      router.refresh();
    } catch {
      toast.error("Failed to save wp.org profile");
    } finally {
      setBusy(null);
    }
  };

  const saveStyle = async (clear = false) => {
    setBusy("style");
    try {
      const res = await fetch(`/api/brands/${brand.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ replyStyle: clear ? "" : style.trim() }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(body.error ?? "Failed to save reply style");
        return;
      }
      toast.success(clear ? "Reply style cleared" : "Reply style saved");
      setEditingStyle(false);
      router.refresh();
    } catch {
      toast.error("Failed to save reply style");
    } finally {
      setBusy(null);
    }
  };

  const importPlugins = async () => {
    setBusy("import");
    try {
      const res = await fetch(`/api/brands/${brand.id}/import-plugins`, {
        method: "POST",
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(body.error ?? "Failed to import plugins");
        return;
      }
      const skippedNote = body.skipped > 0 ? ` (${body.skipped} skipped)` : "";
      toast.success(
        `Imported ${body.imported} plugin${body.imported === 1 ? "" : "s"} from wp.org${skippedNote}`,
        {
          description:
            Array.isArray(body.errors) && body.errors.length > 0
              ? body.errors[0]
              : undefined,
        }
      );
      router.refresh();
    } catch {
      toast.error("Failed to import plugins");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="rounded-lg border">
      {/* flex-wrap: on narrow viewports the actions block drops to its own
          row instead of overflowing and overlapping the badges. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
        <div className="bg-muted flex size-9 shrink-0 items-center justify-center rounded-md">
          <Building2 className="text-muted-foreground size-4" />
        </div>
        {/* basis-56 keeps the info column readable — when the actions block
            can't fit beside it, the block wraps below instead of overlapping. */}
        <div className="min-w-0 grow basis-56">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">{brand.name}</span>
            {brand.wpProfileSlug ? (
              <Badge variant="outline" className="font-mono text-[11px]">
                wp.org/author/{brand.wpProfileSlug}
              </Badge>
            ) : null}
            {brand.replyStyle ? (
              <Badge
                variant="outline"
                className="text-muted-foreground gap-1 text-[11px] font-normal"
                title={brand.replyStyle}
              >
                <MessageSquareText className="size-3" />
                Style set
              </Badge>
            ) : null}
          </div>
          <p className="text-muted-foreground mt-0.5 truncate font-mono text-xs">
            {brand.crispWebsiteId}
          </p>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Badge variant="secondary" className="tabular-nums">
            {brand.pluginCount} plugins
          </Badge>
          <Badge variant="secondary" className="tabular-nums">
            {brand.conversationCount} conversations
          </Badge>
          <Button
            variant="outline"
            size="sm"
            onClick={testConnection}
            disabled={busy !== null}
          >
            {busy === "test" ? (
              <LoaderCircle className="size-3.5 animate-spin" />
            ) : (
              <Plug className="size-3.5" />
            )}
            Test
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setEditingProfile((v) => !v)}
            disabled={busy !== null}
          >
            <Globe className="size-3.5" />
            {brand.wpProfileSlug ? "Update wp.org" : "Set wp.org"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setEditingStyle((v) => !v)}
            disabled={busy !== null}
            title="House-style notes fed into the AI reply drafts"
          >
            <MessageSquareText className="size-3.5" />
            {brand.replyStyle ? "Edit style" : "Reply style"}
          </Button>
          {brand.wpProfileSlug ? (
            <Button
              variant="outline"
              size="sm"
              onClick={importPlugins}
              disabled={busy !== null}
              title="Import all plugins from this wp.org author profile"
            >
              {busy === "import" ? (
                <LoaderCircle className="size-3.5 animate-spin" />
              ) : (
                <PackagePlus className="size-3.5" />
              )}
              Import plugins
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="icon"
            className="text-muted-foreground hover:text-red-600"
            onClick={deleteBrand}
            disabled={busy === "delete"}
            title="Delete brand"
          >
            {busy === "delete" ? (
              <LoaderCircle className="size-4 animate-spin" />
            ) : (
              <Trash2 className="size-4" />
            )}
          </Button>
        </div>
      </div>

      {testResult ? (
        <div
          className={
            "flex items-center gap-2 border-t px-4 py-2 text-xs " +
            (testResult.ok
              ? "text-emerald-700 dark:text-emerald-400"
              : "text-red-600 dark:text-red-400")
          }
        >
          {testResult.ok ? (
            <CheckCircle2 className="size-3.5 shrink-0" />
          ) : (
            <XCircle className="size-3.5 shrink-0" />
          )}
          {testResult.message}
        </div>
      ) : null}

      {editingProfile ? (
        <div className="space-y-3 border-t px-4 py-3">
          <div className="space-y-1.5">
            <Label className="text-xs">wp.org author profile</Label>
            <Input
              value={profile}
              onChange={(e) => setProfile(e.target.value)}
              placeholder="ninjateam"
              className="font-mono text-xs sm:max-w-xs"
            />
            <p className="text-muted-foreground text-xs">
              The username from wordpress.org/plugins/author/&lt;slug&gt;/. Used
              by &ldquo;Import plugins&rdquo; to bulk-add this brand&rsquo;s
              plugins.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              onClick={() => saveProfile(false)}
              disabled={busy === "profile" || !profile.trim()}
            >
              {busy === "profile" ? (
                <LoaderCircle className="size-3.5 animate-spin" />
              ) : null}
              Save profile
            </Button>
            {brand.wpProfileSlug ? (
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground"
                onClick={() => saveProfile(true)}
                disabled={busy === "profile"}
              >
                Clear profile
              </Button>
            ) : null}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setEditingProfile(false)}
              disabled={busy === "profile"}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : null}

      {editingStyle ? (
        <div className="space-y-3 border-t px-4 py-3">
          <div className="space-y-1.5">
            <Label className="text-xs">Reply style</Label>
            <Textarea
              value={style}
              onChange={(e) => setStyle(e.target.value)}
              placeholder={
                "House-style notes for AI reply drafts, e.g.:\n" +
                "- Sign off as “The FileBird team”\n" +
                "- Warm and concise; a single emoji is fine\n" +
                "- Prefer “Kind regards” over “Cheers”"
              }
              rows={5}
              maxLength={2000}
              className="text-xs sm:max-w-lg"
            />
            <p className="text-muted-foreground text-xs">
              Free-text tone, sign-off, emoji policy and phrasing preferences.
              Added to the first-reply and follow-up drafting prompts for this
              brand&rsquo;s plugins. Style guides wording only; it never
              overrides the grounding and correctness rules.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              onClick={() => saveStyle(false)}
              disabled={busy === "style" || !style.trim()}
            >
              {busy === "style" ? (
                <LoaderCircle className="size-3.5 animate-spin" />
              ) : null}
              Save style
            </Button>
            {brand.replyStyle ? (
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground"
                onClick={() => saveStyle(true)}
                disabled={busy === "style"}
              >
                Clear style
              </Button>
            ) : null}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setEditingStyle(false)}
              disabled={busy === "style"}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
