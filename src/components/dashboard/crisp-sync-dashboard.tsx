"use client";

import * as React from "react";

import { CoverageHeatmap } from "@/components/dashboard/coverage-heatmap";
import {
  SyncPanel,
  type LastSyncSummary,
  type PrefillRange,
} from "@/components/dashboard/sync-panel";
import type { SerializedSyncLog } from "@/components/dashboard/sync-log-table";
import type { CoverageResult } from "@/lib/sync/coverage";

interface CrispSyncDashboardProps {
  coverage: CoverageResult;
  lastSync: LastSyncSummary | null;
  recentLogs: SerializedSyncLog[];
  resumePage: number;
}

/**
 * Client wrapper that lets the coverage heatmap talk to the sync panel: click a
 * month cell and its first/last day flow into the range-sync form below. Kept
 * as a tiny lifted-state parent instead of URL params so clicking a cell never
 * triggers a navigation / server re-fetch of the (force-dynamic) dashboard.
 */
export function CrispSyncDashboard({
  coverage,
  lastSync,
  recentLogs,
  resumePage,
}: CrispSyncDashboardProps) {
  const [prefillRange, setPrefillRange] = React.useState<PrefillRange | null>(
    null
  );

  return (
    <div className="space-y-6">
      <CoverageHeatmap
        data={coverage}
        onSelectMonth={(start, end) =>
          // nonce makes re-clicking the same month re-trigger the prefill effect.
          setPrefillRange({ start, end, nonce: Date.now() })
        }
      />
      <SyncPanel
        lastSync={lastSync}
        recentLogs={recentLogs}
        resumePage={resumePage}
        prefillRange={prefillRange}
      />
    </div>
  );
}
