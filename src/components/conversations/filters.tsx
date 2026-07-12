"use client";

import * as React from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Search, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { HelpTip } from "@/components/help-tip";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";

const FILTER_KEYS = [
  "search",
  "state",
  "tag",
  "product",
  "brandId",
  "email",
  "operatorId",
  "hasAttachment",
  "dateFrom",
  "dateTo",
  "preview",
] as const;

/** Radix Select forbids empty-string item values, so "All" uses a sentinel. */
const ALL = "__all__";

interface ConversationFiltersProps {
  states: string[];
  tags: string[];
  operators: Array<{ crispUserId: string; name: string | null }>;
  brands: Array<{ id: string; name: string }>;
  products: string[];
}

export function ConversationFilters({
  states,
  tags,
  operators,
  brands,
  products,
}: ConversationFiltersProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [search, setSearch] = React.useState(searchParams.get("search") ?? "");
  const [email, setEmail] = React.useState(searchParams.get("email") ?? "");
  const [preview, setPreview] = React.useState(searchParams.get("preview") ?? "");

  const setParams = React.useCallback(
    (updates: Record<string, string | null>) => {
      const params = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(updates)) {
        if (value === null || value === "") params.delete(key);
        else params.set(key, value);
      }
      params.delete("page");
      const qs = params.toString();
      router.push(qs ? `${pathname}?${qs}` : pathname);
    },
    [router, pathname, searchParams]
  );

  const hasActiveFilter = FILTER_KEYS.some((key) => searchParams.get(key));

  function clearFilters() {
    setSearch("");
    setEmail("");
    setPreview("");
    router.push(pathname);
  }

  function selectValue(key: string): string {
    return searchParams.get(key) ?? ALL;
  }

  function onSelectChange(key: string) {
    return (value: string) => setParams({ [key]: value === ALL ? null : value });
  }

  return (
    <div className="bg-card space-y-4 rounded-lg border p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">Filters</h2>
        {hasActiveFilter ? (
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground h-7 px-2 text-xs"
            onClick={clearFilters}
          >
            <X className="size-3.5" />
            Clear filters
          </Button>
        ) : null}
      </div>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          setParams({ search });
        }}
      >
        <div className="relative">
          <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search messages…"
            className="h-8 pl-8 text-sm"
            aria-label="Search conversations"
          />
        </div>
      </form>

      <div className="space-y-1.5">
        <Label htmlFor="filter-state" className="text-muted-foreground text-xs">
          State
        </Label>
        <Select value={selectValue("state")} onValueChange={onSelectChange("state")}>
          <SelectTrigger id="filter-state" size="sm" className="w-full">
            <SelectValue placeholder="All states" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All states</SelectItem>
            {states.map((state) => (
              <SelectItem key={state} value={state} className="capitalize">
                {state}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="filter-tag" className="text-muted-foreground text-xs">
          Tag
        </Label>
        <Select value={selectValue("tag")} onValueChange={onSelectChange("tag")}>
          <SelectTrigger id="filter-tag" size="sm" className="w-full">
            <SelectValue placeholder="All tags" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All tags</SelectItem>
            {tags.map((tag) => (
              <SelectItem key={tag} value={tag}>
                {tag}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1.5">
        <Label
          htmlFor="filter-product"
          className="text-muted-foreground text-xs"
        >
          Product
        </Label>
        <Select
          value={selectValue("product")}
          onValueChange={onSelectChange("product")}
        >
          <SelectTrigger id="filter-product" size="sm" className="w-full">
            <SelectValue placeholder="All products" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All products</SelectItem>
            {products.map((product) => (
              <SelectItem key={product} value={product}>
                {product}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {brands.length > 0 ? (
        <div className="space-y-1.5">
          <Label
            htmlFor="filter-brand"
            className="text-muted-foreground text-xs"
          >
            Brand
          </Label>
          <Select
            value={selectValue("brandId")}
            onValueChange={onSelectChange("brandId")}
          >
            <SelectTrigger id="filter-brand" size="sm" className="w-full">
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
      ) : null}

      <div className="space-y-1.5">
        <Label
          htmlFor="filter-operator"
          className="text-muted-foreground text-xs"
        >
          Operator
        </Label>
        <Select
          value={selectValue("operatorId")}
          onValueChange={onSelectChange("operatorId")}
        >
          <SelectTrigger id="filter-operator" size="sm" className="w-full">
            <SelectValue placeholder="All operators" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All operators</SelectItem>
            {operators.map((operator) => (
              <SelectItem
                key={operator.crispUserId}
                value={operator.crispUserId}
              >
                {operator.name ?? operator.crispUserId}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          setParams({ email });
        }}
        className="space-y-1.5"
      >
        <Label htmlFor="filter-email" className="text-muted-foreground text-xs">
          Visitor email
        </Label>
        <Input
          id="filter-email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="name@example.com"
          className="h-8 text-sm"
        />
      </form>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          setParams({ preview });
        }}
        className="space-y-1.5"
      >
        <div className="flex items-center gap-1">
          <Label htmlFor="filter-preview" className="text-muted-foreground text-xs">
            Preview contains
          </Label>
          <HelpTip subject="Preview contains">
            Matches the conversation&rsquo;s last-message preview exactly as
            typed (case-insensitive) — unlike Search, it doesn&rsquo;t split
            the text into separate words. Useful for isolating automated or
            junk email threads, e.g. &quot;[WordPress Plugin]&quot;
            notifications, without pulling in unrelated conversations that
            merely mention the same words.
          </HelpTip>
        </div>
        <Input
          id="filter-preview"
          value={preview}
          onChange={(event) => setPreview(event.target.value)}
          placeholder="[WordPress Plugin]"
          className="h-8 text-sm"
        />
      </form>

      <div className="space-y-1.5">
        <Label htmlFor="filter-date-from" className="text-muted-foreground text-xs">
          From
        </Label>
        <Input
          id="filter-date-from"
          type="date"
          value={searchParams.get("dateFrom") ?? ""}
          onChange={(event) => setParams({ dateFrom: event.target.value })}
          className="h-8 text-sm"
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="filter-date-to" className="text-muted-foreground text-xs">
          To
        </Label>
        <Input
          id="filter-date-to"
          type="date"
          value={searchParams.get("dateTo") ?? ""}
          onChange={(event) => setParams({ dateTo: event.target.value })}
          className="h-8 text-sm"
        />
      </div>

      <div className="flex items-center justify-between pt-1">
        <Label
          htmlFor="filter-has-attachment"
          className="text-muted-foreground text-xs"
        >
          Has attachment
        </Label>
        <Switch
          id="filter-has-attachment"
          checked={searchParams.get("hasAttachment") === "true"}
          onCheckedChange={(checked) =>
            setParams({ hasAttachment: checked ? "true" : null })
          }
        />
      </div>
    </div>
  );
}
