"use client";

import * as React from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { HelpTip } from "@/components/help-tip";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/** Radix Select forbids an empty-string item value, so "All brands" uses a sentinel. */
const ALL = "__all__";

export interface BrandOption {
  id: string;
  name: string;
}

interface BrandSelectorProps {
  brands: BrandOption[];
  /** The currently selected Brand.id, or undefined for "All brands". */
  selectedBrandId?: string;
}

/**
 * Scopes the whole Crisp dashboard to one brand via a `?brand=<id>` URL
 * param — absent means "All brands". A plain `<Select>` synced to the URL
 * (not local state) so the scope survives a reload/share and every stat,
 * heatmap, and range-sync default on the page can read it straight off
 * `searchParams` server-side. `router.replace` (not `push`) so switching
 * brands doesn't pile up back-button history, and `scroll: false` so
 * flipping brands never yanks the page back to the top.
 */
export function BrandSelector({ brands, selectedBrandId }: BrandSelectorProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const value = selectedBrandId ?? ALL;

  function onValueChange(next: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (next === ALL) params.delete("brand");
    else params.set("brand", next);
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }

  return (
    <div className="flex items-center gap-1.5">
      <Select value={value} onValueChange={onValueChange}>
        <SelectTrigger id="brand-selector" className="w-64">
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
      <HelpTip subject="brand selector">
        Scopes this whole page — the stats above, the archive coverage
        grid(s), and the range-sync default — to one Crisp website. Pick
        &quot;All brands&quot; to see every brand&apos;s coverage stacked
        separately (never merged into one grid, so one brand&apos;s data can
        never hide another&apos;s gap).
      </HelpTip>
    </div>
  );
}
