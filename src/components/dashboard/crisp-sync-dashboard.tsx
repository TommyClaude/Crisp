"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { LoaderCircle } from "lucide-react";
import { toast } from "sonner";

import { HelpTip } from "@/components/help-tip";
import { Button } from "@/components/ui/button";
import { CoverageHeatmap } from "@/components/dashboard/coverage-heatmap";
import {
  SyncPanel,
  type LastSyncSummary,
  type PrefillRange,
} from "@/components/dashboard/sync-panel";
import type { SerializedSyncLog } from "@/components/dashboard/sync-log-table";
import type { CoverageResult } from "@/lib/sync/coverage";

export interface BrandOption {
  id: string;
  name: string;
}

/**
 * What to render for the Archive coverage section. Never a single grid
 * merged across brands (the owner's explicit complaint — a filled month for
 * brand B must never hide brand A's gap):
 *  - "single": one brand is selected — one grid, scoped via
 *    getArchiveCoverage({brandId}).
 *  - "stacked": "All brands" with 2+ Brand rows configured — one COMPACT grid
 *    PER brand, stacked vertically, each queried with its own brandId.
 *  - "merged": the legacy env-only fallback (zero Brand rows, so there is
 *    nothing to scope by) — the one all-brands grid, same as before this
 *    feature existed.
 */
export type CoverageView =
  | { mode: "single"; brandId: string; brandName: string; data: CoverageResult }
  | {
      mode: "stacked";
      brands: Array<{ brandId: string; brandName: string; data: CoverageResult }>;
    }
  | { mode: "merged"; data: CoverageResult };

interface CrispSyncDashboardProps {
  coverageView: CoverageView;
  brands: BrandOption[];
  /** The URL-selected brand (see BrandSelector) — undefined means "All brands". */
  selectedBrandId?: string;
  lastSync: LastSyncSummary | null;
  recentLogs: SerializedSyncLog[];
  resumePage: number;
  /** Each configured brand's own furthest page across history — see getResumePages. */
  resumePages: Record<string, number>;
}

/**
 * Spends ~10 tiny Crisp requests PER BRAND to find each brand's true first
 * conversation (see /api/sync/crisp/detect-start), stores the result, then
 * refreshes. Rendered once for the whole "All brands" stacked view — the
 * detect endpoint always probes every configured brand regardless of which
 * card you'd click it from, so one shared control (rather than one per
 * compact card) avoids three buttons doing the exact same thing.
 */
function DetectArchiveStartControl() {
  const router = useRouter();
  const [detecting, setDetecting] = React.useState(false);

  const handleDetectArchiveStart = React.useCallback(async () => {
    setDetecting(true);
    try {
      const res = await fetch("/api/sync/crisp/detect-start", { method: "POST" });
      const body = (await res.json().catch(() => null)) as
        | { earliestMonth?: string | null; error?: string }
        | null;
      if (!res.ok || !body?.earliestMonth) {
        toast.error(body?.error ?? "Failed to detect archive start");
        return;
      }
      toast.success("Archive start detected", {
        description: "Each brand's grid now widens to show unsynced years as gaps.",
      });
      router.refresh();
    } catch {
      toast.error("Failed to detect archive start");
    } finally {
      setDetecting(false);
    }
  }, [router]);

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-1">
      <Button
        variant="ghost"
        size="sm"
        onClick={handleDetectArchiveStart}
        disabled={detecting}
        className="h-6 px-2 text-xs"
      >
        {detecting ? <LoaderCircle className="size-3 animate-spin" /> : null}
        Detect archive start (all brands)
      </Button>
      <HelpTip subject="detect archive start">
        Probes every configured brand (~10 tiny Crisp requests each, binary
        search by month) to find each brand&apos;s first conversation ever and
        widens its grid above so unsynced years show up as gaps instead of
        being cut off. Also runs automatically on every full sync for brands
        missing a result.
      </HelpTip>
    </div>
  );
}

/**
 * Client wrapper that lets the coverage heatmap(s) talk to the sync panel:
 * click a month cell and its first/last day — AND which brand's grid it came
 * from — flow into the range-sync form below. Kept as a tiny lifted-state
 * parent instead of URL params so clicking a cell never triggers a
 * navigation / server re-fetch of the (force-dynamic) dashboard. The parent
 * page remounts this component (via a `key` on selectedBrandId) whenever the
 * brand SELECTOR changes, so a stale prefill from a previously-visible grid
 * never survives a brand switch.
 */
export function CrispSyncDashboard({
  coverageView,
  brands,
  selectedBrandId,
  lastSync,
  recentLogs,
  resumePage,
  resumePages,
}: CrispSyncDashboardProps) {
  const [prefillRange, setPrefillRange] = React.useState<PrefillRange | null>(
    null
  );

  const handleSelectMonth = React.useCallback(
    (start: string, end: string, brandId: string | undefined) => {
      // nonce makes re-clicking the same month re-trigger the prefill effect.
      setPrefillRange({ start, end, brandId, nonce: Date.now() });
    },
    []
  );

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        {coverageView.mode === "single" && (
          <CoverageHeatmap
            data={coverageView.data}
            brandId={coverageView.brandId}
            onSelectMonth={(start, end) =>
              handleSelectMonth(start, end, coverageView.brandId)
            }
          />
        )}
        {coverageView.mode === "merged" && (
          <CoverageHeatmap
            data={coverageView.data}
            onSelectMonth={(start, end) =>
              handleSelectMonth(start, end, undefined)
            }
          />
        )}
        {coverageView.mode === "stacked" && (
          <>
            {coverageView.brands.map((brand) => (
              <CoverageHeatmap
                key={brand.brandId}
                compact
                title={brand.brandName}
                data={brand.data}
                brandId={brand.brandId}
                onSelectMonth={(start, end) =>
                  handleSelectMonth(start, end, brand.brandId)
                }
              />
            ))}
            <DetectArchiveStartControl />
          </>
        )}
      </div>
      <SyncPanel
        lastSync={lastSync}
        recentLogs={recentLogs}
        resumePage={resumePage}
        resumePages={resumePages}
        prefillRange={prefillRange}
        brands={brands}
        selectedBrandId={selectedBrandId}
      />
    </div>
  );
}
