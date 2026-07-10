"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Building2, Globe, LoaderCircle, Plus, Trash2 } from "lucide-react";
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

export interface BrandItem {
  id: string;
  name: string;
  domain: string | null;
  crispWebsiteId: string;
  pluginCount: number;
  conversationCount: number;
}

export function BrandManager({ brands }: { brands: BrandItem[] }) {
  const router = useRouter();
  const [name, setName] = React.useState("");
  const [websiteId, setWebsiteId] = React.useState("");
  const [domain, setDomain] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [deletingId, setDeletingId] = React.useState<string | null>(null);

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
          domain: domain.trim() || undefined,
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
      setDomain("");
      router.refresh();
    } catch {
      toast.error("Failed to create brand");
    } finally {
      setSaving(false);
    }
  };

  const deleteBrand = async (brand: BrandItem) => {
    if (
      !window.confirm(
        `Delete brand "${brand.name}"? Its plugins and ingested docs are removed; conversations are kept.`
      )
    ) {
      return;
    }
    setDeletingId(brand.id);
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
      setDeletingId(null);
    }
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Add a brand</CardTitle>
          <CardDescription>
            The website ID is in the Crisp app URL:
            app.crisp.chat/website/<span className="font-mono">&lt;website-id&gt;</span>/inbox
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            onSubmit={createBrand}
            className="grid gap-3 sm:grid-cols-[1fr_1.4fr_1fr_auto]"
          >
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
              <Label htmlFor="brand-domain">Domain (optional)</Label>
              <Input
                id="brand-domain"
                placeholder="yaycommerce.com"
                value={domain}
                onChange={(e) => setDomain(e.target.value)}
              />
            </div>
            <div className="flex items-end">
              <Button type="submit" disabled={saving || !name || !websiteId}>
                {saving ? (
                  <LoaderCircle className="size-4 animate-spin" />
                ) : (
                  <Plus className="size-4" />
                )}
                Add
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      {brands.length === 0 ? (
        <div className="text-muted-foreground rounded-lg border border-dashed p-10 text-center text-sm">
          <Building2 className="mx-auto mb-2 size-6 opacity-60" />
          No brands yet — add one per Crisp website to start syncing.
        </div>
      ) : (
        <div className="divide-y rounded-lg border">
          {brands.map((brand) => (
            <div key={brand.id} className="flex items-center gap-4 px-4 py-3">
              <div className="bg-muted flex size-9 shrink-0 items-center justify-center rounded-md">
                <Building2 className="text-muted-foreground size-4" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{brand.name}</span>
                  {brand.domain ? (
                    <span className="text-muted-foreground inline-flex items-center gap-1 text-xs">
                      <Globe className="size-3" />
                      {brand.domain}
                    </span>
                  ) : null}
                </div>
                <p className="text-muted-foreground mt-0.5 truncate font-mono text-xs">
                  {brand.crispWebsiteId}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Badge variant="secondary" className="tabular-nums">
                  {brand.pluginCount} plugins
                </Badge>
                <Badge variant="secondary" className="tabular-nums">
                  {brand.conversationCount} conversations
                </Badge>
                <Button
                  variant="ghost"
                  size="icon"
                  className="text-muted-foreground hover:text-red-600"
                  onClick={() => deleteBrand(brand)}
                  disabled={deletingId === brand.id}
                  title="Delete brand"
                >
                  {deletingId === brand.id ? (
                    <LoaderCircle className="size-4 animate-spin" />
                  ) : (
                    <Trash2 className="size-4" />
                  )}
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
