"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { CalendarRange, LoaderCircle } from "lucide-react";
import { toast } from "sonner";

import { HelpTip } from "@/components/help-tip";
import { Button } from "@/components/ui/button";
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
  earliestDetectedMonth,
  intensityLevel,
  parseMonthLabel,
  toMonthIndex,
  type CoverageResult,
  type YearMonth,
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

/** {year:2018,month:6} -> "June 2018", for the detected-start one-liner. */
function formatMonthYearLabel(ym: YearMonth): string {
  return `${MONTHS_LONG[ym.month - 1] ?? "?"} ${ym.year}`;
}

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
  /**
   * The Brand.id `data` was fetched with (see getArchiveCoverage's brandId
   * option) — used ONLY to read that brand's own entry out of
   * data.detectedArchiveStart.brands for the "Archive starts ..." footer,
   * instead of the all-brands minimum. Omit for merged/all-brands data (the
   * legacy no-Brand-rows fallback), where the all-brands minimum IS the
   * right thing to show.
   */
  brandId?: string;
  /**
   * Compact rendering for the all-brands stacked view (one card per brand):
   * smaller cells, a plain brand-name header instead of "Archive coverage",
   * and no legend / detect-archive-start chrome (that stays on the
   * single-brand and merged views — running it once covers every brand
   * anyway, so repeating the control on every card would be redundant).
   */
  compact?: boolean;
  /** Header title — defaults to "Archive coverage"; compact instances pass the brand name. */
  title?: string;
}

export function CoverageHeatmap({
  data,
  onSelectMonth,
  brandId,
  compact = false,
  title = "Archive coverage",
}: CoverageHeatmapProps) {
  const router = useRouter();
  const [detecting, setDetecting] = React.useState(false);

  // Year/month granularity is stable across SSR and hydration. The grid
  // spans from the earliest KNOWN month (the DB's own minimum timestamps
  // and/or a stored "Detect archive start" result — see
  // data.earliestKnownMonth in coverage-query.ts) through the current month,
  // falling back to the current month alone when nothing is known yet.
  const now = new Date();
  const currentYear = now.getUTCFullYear();
  const currentMonth = now.getUTCMonth() + 1;

  // Scoped to `brandId` when given: that brand's own detected month (a
  // negative-cache null entry counts as "not detected"). Otherwise the
  // earliest across every brand that HAS been detected — matches how
  // getArchiveCoverage itself resolves earliestKnownMonth, so this label
  // never disagrees with the grid it sits under.
  const detectedMonth = data.detectedArchiveStart
    ? brandId
      ? ((label) => (label ? parseMonthLabel(label) : null))(
          data.detectedArchiveStart.brands[brandId] ?? null
        )
      : earliestDetectedMonth(data.detectedArchiveStart.brands)
    : null;

  // A grid renders whenever there's SOMETHING to show: real conversations, or
  // a detected start with none synced yet (a legitimate "here's the gap, all
  // of it" visualization) — only truly nothing-known collapses to the
  // one-line empty state below.
  const grid = React.useMemo(() => {
    if (data.total <= 0 && !detectedMonth) return null;
    return buildCoverageGrid(data.monthly, {
      start: data.earliestKnownMonth ?? { year: currentYear, month: currentMonth },
      end: { year: currentYear, month: currentMonth },
    });
  }, [
    data.monthly,
    data.total,
    data.earliestKnownMonth,
    detectedMonth,
    currentYear,
    currentMonth,
  ]);
  const rows = grid?.rows ?? [];
  const maxCount = grid?.maxCount ?? 0;

  // Dashed "outside the archive" cells sit on BOTH ends of the grid: before
  // the (possibly 15-year-clamped) span start, and after the current month
  // (this month is partial, later ones haven't happened yet). Compared
  // against grid.effectiveSpan — not the requested span — so a clamp is
  // reflected here too, and the clamp math lives in exactly one place
  // (buildCoverageGrid).
  const isOutsideSpan = (year: number, month: number) => {
    if (!grid) return false;
    const index = toMonthIndex(year, month);
    const { start, end } = grid.effectiveSpan;
    return (
      index < toMonthIndex(start.year, start.month) ||
      index > toMonthIndex(end.year, end.month)
    );
  };

  // Spend ~10 tiny Crisp requests to find the true archive start (see
  // src/app/api/sync/crisp/detect-start/route.ts), store it, then refresh —
  // same "poll finished, router.refresh()" pattern the sync panel uses once
  // a background sync completes.
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
      const earliest = parseMonthLabel(body.earliestMonth);
      toast.success(
        earliest
          ? `Archive starts ${formatMonthYearLabel(earliest)}`
          : "Archive start detected",
        { description: "The grid now widens to show unsynced years as gaps." }
      );
      router.refresh();
    } catch {
      toast.error("Failed to detect archive start");
    } finally {
      setDetecting(false);
    }
  }, [router]);

  const cellSize = compact ? "size-5" : "size-7";
  const yearColWidth = compact ? "2rem" : "2.5rem";
  const cellColWidth = compact ? "1.35rem" : "1.75rem";
  const gridTemplateColumns = `${yearColWidth} repeat(12, ${cellColWidth})`;

  return (
    <Card>
      <CardHeader className={compact ? "gap-1" : undefined}>
        <CardTitle
          className={
            compact
              ? "flex items-center justify-between text-sm font-medium"
              : "flex items-center gap-2"
          }
        >
          {compact ? (
            <>
              <span>{title}</span>
              <span className="text-muted-foreground text-xs font-normal tabular-nums">
                {numberFormat.format(data.total)} conversation
                {data.total === 1 ? "" : "s"}
              </span>
            </>
          ) : (
            <>
              <CalendarRange className="text-muted-foreground size-4" />
              {title}
              <HelpTip subject="archive coverage">
                Each cell buckets conversations by their <strong>last activity</strong>{" "}
                date. A darker cell means more conversations that month; an empty
                month sitting between active months usually means that period was
                never synced. Click a month to prefill the range sync below and
                backfill exactly that gap.
              </HelpTip>
            </>
          )}
        </CardTitle>
        {!compact && (
          <CardDescription>
            {data.total > 0
              ? `${numberFormat.format(data.total)} conversations by month — spot the gaps, then click a month to refill it.`
              : "No conversations archived yet."}
          </CardDescription>
        )}
        {!compact && rows.length > 0 && (
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
      <CardContent className={compact ? "pt-0" : undefined}>
        {rows.length === 0 ? (
          <p
            className={cn(
              "text-muted-foreground text-sm",
              compact ? "py-1 text-xs" : "py-6 text-center"
            )}
          >
            {compact
              ? "No conversations synced yet."
              : "No dated conversations yet. Run a sync to populate the archive, then this heatmap shows which months are covered."}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <div className="inline-block min-w-max">
              {/* Month header row */}
              <div className="grid gap-1" style={{ gridTemplateColumns }}>
                <span aria-hidden />
                {MONTHS_SHORT.map((label) => (
                  <span
                    key={label}
                    className={cn(
                      "text-muted-foreground text-center leading-6",
                      compact ? "text-[9px]" : "text-[10px]"
                    )}
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
                  style={{ gridTemplateColumns }}
                >
                  <span className="text-muted-foreground pr-1 text-right text-xs leading-7 tabular-nums">
                    {row.year}
                  </span>
                  {row.cells.map((cell) => {
                    const outside = isOutsideSpan(cell.year, cell.month);
                    const level = intensityLevel(cell.count, maxCount);
                    const label = `${MONTHS_LONG[cell.month - 1]} ${cell.year} — ${numberFormat.format(cell.count)} conversation${cell.count === 1 ? "" : "s"}`;

                    if (outside) {
                      return (
                        <span
                          key={cell.month}
                          aria-hidden
                          className={cn(
                            "border-border/40 rounded-md border border-dashed",
                            cellSize
                          )}
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
                          "focus-visible:ring-ring/60 rounded-md transition-[outline,box-shadow] outline-none hover:ring-2 hover:ring-blue-500/50 focus-visible:ring-2",
                          cellSize,
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

        {/* Below the grid: either an invitation to widen it (no detected
            start on file yet), or a quiet note that it's already been done.
            Detection also runs automatically on every full sync (see
            runSync's auto-detect hook) — this button is the manual trigger /
            retry, so there's no button once a result is stored, only a cheap
            re-detect link. Compact cards (the all-brands stacked view) skip
            the interactive part entirely: detecting always probes EVERY
            brand (see /api/sync/crisp/detect-start), so repeating the button
            on each card would just be three ways to trigger the same action
            — the merged/single-brand view keeps the one real control. */}
        {rows.length > 0 &&
          (detectedMonth ? (
            compact ? (
              <p className="text-muted-foreground mt-2 text-xs">
                Archive starts{" "}
                <span className="text-foreground font-medium">
                  {formatMonthYearLabel(detectedMonth)}
                </span>
              </p>
            ) : (
              <p className="text-muted-foreground mt-3 text-xs">
                Archive starts{" "}
                <span className="text-foreground font-medium">
                  {formatMonthYearLabel(detectedMonth)}
                </span>{" "}
                (detected).{" "}
                <button
                  type="button"
                  onClick={handleDetectArchiveStart}
                  disabled={detecting}
                  className="hover:text-foreground underline underline-offset-2 disabled:opacity-50"
                >
                  {detecting ? "Re-detecting…" : "Re-detect"}
                </button>
              </p>
            )
          ) : compact ? null : (
            <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1">
              <p className="text-muted-foreground text-xs">
                Grid spans the data synced so far — the real archive may start
                earlier.
              </p>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleDetectArchiveStart}
                disabled={detecting}
                className="h-6 px-2 text-xs"
              >
                {detecting ? (
                  <LoaderCircle className="size-3 animate-spin" />
                ) : null}
                Detect archive start
              </Button>
              <HelpTip subject="detect archive start">
                Runs automatically on every full sync; use this button to
                detect it without syncing. Probes Crisp with about 10 tiny
                requests per brand (binary search by month) to find each
                brand&apos;s first conversation ever, stores the result, and
                widens the grid so unsynced years show up as gaps instead of
                being cut off.
              </HelpTip>
            </div>
          ))}

        {data.unknownCount > 0 && (
          <p
            className={cn(
              "text-muted-foreground flex items-center gap-1 text-xs",
              compact ? "mt-2" : "mt-4"
            )}
          >
            {numberFormat.format(data.unknownCount)} conversation
            {data.unknownCount === 1 ? "" : "s"} with unknown dates (no last-activity
            timestamp) — not shown above.
            {!compact && (
              <HelpTip subject="unknown dates">
                These conversations have no last-activity timestamp from Crisp, so
                they can&apos;t be placed on the calendar. They&apos;re still in the
                archive and searchable.
              </HelpTip>
            )}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
