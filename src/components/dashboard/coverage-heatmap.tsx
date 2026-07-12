"use client";

import * as React from "react";
import { CalendarRange } from "lucide-react";

import { HelpTip } from "@/components/help-tip";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  buildCoverageGrid,
  intensityLevel,
  type CoverageResult,
} from "@/lib/sync/coverage";
import { cn } from "@/lib/utils";

const MONTHS_SHORT = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];
const MONTHS_LONG = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const numberFormat = new Intl.NumberFormat("en-US");

/**
 * Sequential single-hue (blue) ramp, light→dark, with a DISTINCT empty step so
 * "no conversations" reads as categorically different from "a few" rather than
 * just the faintest blue. Dark mode steps up the same blue's opacity against
 * the dark card surface, so "more" stays brighter in both themes.
 */
const CELL_STYLE: Record<0 | 1 | 2 | 3 | 4, string> = {
  0: "bg-muted/60 dark:bg-muted/40",
  1: "bg-blue-100 dark:bg-blue-500/25",
  2: "bg-blue-300 dark:bg-blue-500/45",
  3: "bg-blue-500 dark:bg-blue-500/70",
  4: "bg-blue-700 dark:bg-blue-500",
};

/** First and last calendar day of a month as YYYY-MM-DD (UTC-safe, no Date math on the boundary). */
function monthRange(year: number, month: number): { start: string; end: string } {
  const mm = String(month).padStart(2, "0");
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    start: `${year}-${mm}-01`,
    end: `${year}-${mm}-${String(lastDay).padStart(2, "0")}`,
  };
}

export interface CoverageHeatmapProps {
  data: CoverageResult;
  /** Called with a month's first/last day (YYYY-MM-DD) when a cell is clicked. */
  onSelectMonth?: (start: string, end: string) => void;
}

export function CoverageHeatmap({ data, onSelectMonth }: CoverageHeatmapProps) {
  const { rows, maxCount } = React.useMemo(
    () => buildCoverageGrid(data.monthly),
    [data.monthly]
  );

  // Dim months that can't have data yet (this month is partial, later ones are
  // in the future). Year/month granularity is stable across SSR and hydration.
  const now = new Date();
  const currentYear = now.getUTCFullYear();
  const currentMonth = now.getUTCMonth() + 1;
  const isFuture = (year: number, month: number) =>
    year > currentYear || (year === currentYear && month > currentMonth);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <CalendarRange className="text-muted-foreground size-4" />
          Archive coverage
          <HelpTip subject="archive coverage">
            Each cell buckets conversations by their <strong>last activity</strong>{" "}
            date. A darker cell means more conversations that month; an empty
            month sitting between active months usually means that period was
            never synced. Click a month to prefill the range sync below and
            backfill exactly that gap.
          </HelpTip>
        </CardTitle>
        <CardDescription>
          {data.total > 0
            ? `${numberFormat.format(data.total)} conversations by month — spot the gaps, then click a month to refill it.`
            : "No conversations archived yet."}
        </CardDescription>
        {rows.length > 0 && (
          <CardAction>
            <div className="text-muted-foreground flex items-center gap-1.5 text-xs">
              <span>Less</span>
              {([1, 2, 3, 4] as const).map((level) => (
                <span
                  key={level}
                  className={cn("size-3 rounded-[3px]", CELL_STYLE[level])}
                />
              ))}
              <span>More</span>
            </div>
          </CardAction>
        )}
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-muted-foreground py-6 text-center text-sm">
            No dated conversations yet. Run a sync to populate the archive, then
            this heatmap shows which months are covered.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <div className="inline-block min-w-max">
              {/* Month header row */}
              <div
                className="grid gap-1"
                style={{
                  gridTemplateColumns: "2.5rem repeat(12, 1.75rem)",
                }}
              >
                <span aria-hidden />
                {MONTHS_SHORT.map((label) => (
                  <span
                    key={label}
                    className="text-muted-foreground text-center text-[10px] leading-6"
                  >
                    {label}
                  </span>
                ))}
              </div>
              {/* One row per year */}
              {rows.map((row) => (
                <div
                  key={row.year}
                  className="grid gap-1 pb-1"
                  style={{
                    gridTemplateColumns: "2.5rem repeat(12, 1.75rem)",
                  }}
                >
                  <span className="text-muted-foreground pr-1 text-right text-xs leading-7 tabular-nums">
                    {row.year}
                  </span>
                  {row.cells.map((cell) => {
                    const future = isFuture(cell.year, cell.month);
                    const level = intensityLevel(cell.count, maxCount);
                    const label = `${MONTHS_LONG[cell.month - 1]} ${cell.year} — ${numberFormat.format(cell.count)} conversation${cell.count === 1 ? "" : "s"}`;

                    if (future) {
                      return (
                        <span
                          key={cell.month}
                          aria-hidden
                          className="border-border/40 size-7 rounded-md border border-dashed"
                        />
                      );
                    }
                    return (
                      <button
                        key={cell.month}
                        type="button"
                        title={label}
                        aria-label={`${label}. Click to sync this month.`}
                        onClick={() => {
                          const { start, end } = monthRange(cell.year, cell.month);
                          onSelectMonth?.(start, end);
                        }}
                        className={cn(
                          "focus-visible:ring-ring/60 size-7 rounded-md transition-[outline,box-shadow] outline-none hover:ring-2 hover:ring-blue-500/50 focus-visible:ring-2",
                          CELL_STYLE[level]
                        )}
                      />
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        )}

        {data.unknownCount > 0 && (
          <p className="text-muted-foreground mt-4 flex items-center gap-1 text-xs">
            {numberFormat.format(data.unknownCount)} conversation
            {data.unknownCount === 1 ? "" : "s"} with unknown dates (no last-activity
            timestamp) — not shown above.
            <HelpTip subject="unknown dates">
              These conversations have no last-activity timestamp from Crisp, so
              they can&apos;t be placed on the calendar. They&apos;re still in the
              archive and searchable.
            </HelpTip>
          </p>
        )}
      </CardContent>
    </Card>
  );
}
