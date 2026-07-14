"use client";

import { format } from "date-fns";

import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import type { BrandPagesMap } from "@/lib/sync/sync-service";

/** A SyncLog row with Date fields serialized to ISO strings. */
export interface SerializedSyncLog {
  id: string;
  kind: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  pageFrom: number | null;
  pageTo: number | null;
  conversationsSynced: number;
  messagesSynced: number;
  failedSessions: string[];
  error: string | null;
  /** Set only on brand-scoped range runs (see runRangeSync's brandId option); null otherwise. */
  brandId: string | null;
  /**
   * Raw SyncLog.brandPages JSON (see BrandPagesMap in sync-service.ts) — per-
   * brand page ranges for this run, or null/absent on legacy rows written
   * before this column existed. Parsed defensively by parseBrandPages below
   * (this component never imports sync-service.ts itself — that's a server
   * module reaching into Prisma — so the tiny parser is duplicated locally).
   */
  brandPages?: unknown;
}

const STATUS_STYLES: Record<string, string> = {
  completed:
    "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-400",
  failed:
    "border-red-200 bg-red-50 text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-400",
  running:
    "animate-pulse border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-500/30 dark:bg-blue-500/10 dark:text-blue-400",
  cancelled:
    "border-zinc-200 bg-zinc-100 text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-400",
  paused:
    "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-400",
};

function StatusBadge({ status }: { status: string }) {
  return (
    <Badge
      variant="outline"
      className={cn("capitalize", STATUS_STYLES[status])}
    >
      {status}
    </Badge>
  );
}

function formatStarted(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "—" : format(date, "MMM d, HH:mm");
}

function formatDuration(startedAt: string, finishedAt: string | null): string {
  if (!finishedAt) return "—";
  const ms = new Date(finishedAt).getTime() - new Date(startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function formatPages(pageFrom: number | null, pageTo: number | null): string {
  if (pageFrom == null && pageTo == null) return "—";
  return `${pageFrom ?? "?"} → ${pageTo ?? "?"}`;
}

/**
 * Mirrors parseBrandPages in sync-service.ts. Duplicated (not imported) on
 * purpose: sync-service.ts pulls in Prisma and other server-only modules,
 * which this "use client" table must never bundle. Coerces the raw JSON
 * column into a typed map, or null when absent/malformed/empty.
 */
function parseBrandPages(value: unknown): BrandPagesMap | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result: BrandPagesMap = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const from = (entry as { from?: unknown } | null)?.from;
    const to = (entry as { to?: unknown } | null)?.to;
    const ceiling = (entry as { ceiling?: unknown } | null)?.ceiling;
    if (typeof from === "number" && typeof to === "number") {
      result[key] = {
        from,
        to,
        synced: 0,
        ...(ceiling === true ? { ceiling: true } : {}),
      };
    }
  }
  return Object.keys(result).length > 0 ? result : null;
}

/** brandId (or "default") -> display name for a Pages-column range. */
function brandPagesLabel(
  key: string,
  brands: Array<{ id: string; name: string }>
): string {
  if (key === "default") return "default";
  return brands.find((b) => b.id === key)?.name ?? key;
}

/**
 * The Pages column's cell content. When the run recorded per-brand progress
 * (SyncLog.brandPages — see BrandPagesMap), show each brand's own range, e.g.
 * "NinjaTeam 197→376 · YayCommerce 1→12" — the single legacy "from → to" text
 * hid exactly this (a resumed run's true per-brand start pages). A lone
 * "default" entry (the legacy env-only fallback, one implicit target) renders
 * as the plain single-range form instead, since there's no second brand to
 * disambiguate from. Falls back to the legacy pageFrom/pageTo text entirely
 * when brandPages is absent (old rows, written before this column existed).
 */
function formatPagesCell(
  log: Pick<SerializedSyncLog, "pageFrom" | "pageTo" | "brandPages">,
  brands: Array<{ id: string; name: string }>
): { text: string; title?: string } {
  const brandPages = parseBrandPages(log.brandPages);
  if (!brandPages) return { text: formatPages(log.pageFrom, log.pageTo) };

  const remainingKeys = new Set(Object.keys(brandPages));
  if (remainingKeys.size === 1 && remainingKeys.has("default")) {
    const entry = brandPages.default;
    const text = `${entry.from} → ${entry.to}${entry.ceiling ? " (ceiling)" : ""}`;
    return {
      text,
      title: entry.ceiling
        ? "Reached Crisp's 1,000-page pagination ceiling — older conversations need a date-range sync."
        : undefined,
    };
  }

  // Stable, predictable order: known brands in the SAME order as the
  // `brands` prop (the dashboard page's name-asc order), then any leftover
  // keys (a since-deleted brand, or the legacy "default" key) in whatever
  // order remains. Needed because jsonb does NOT preserve insertion order —
  // without this, a run's brand list could shuffle on every read.
  const orderedKeys: string[] = [];
  for (const brand of brands) {
    if (remainingKeys.has(brand.id)) {
      orderedKeys.push(brand.id);
      remainingKeys.delete(brand.id);
    }
  }
  orderedKeys.push(...remainingKeys);

  const text = orderedKeys
    .map((key) => {
      const entry = brandPages[key];
      const suffix = entry.ceiling ? " (ceiling)" : "";
      return `${brandPagesLabel(key, brands)} ${entry.from}→${entry.to}${suffix}`;
    })
    .join(" · ");
  // Always carry the full text as a hover title — even 2 brands' worth of
  // "Name NNN→NNN" routinely overflows the cell's max-width (see the
  // TableCell's truncate class), so the multi-brand case can never rely on
  // the text alone to be readable.
  return { text, title: text };
}

const numberFormat = new Intl.NumberFormat("en-US");

/** brandId -> brand name for a range-run's badge; null (all brands) or an id no longer in `brands` (deleted since) get their own labels. */
function brandBadgeLabel(
  brandId: string | null,
  brands: Array<{ id: string; name: string }>
): string {
  if (brandId === null) return "All brands";
  return brands.find((b) => b.id === brandId)?.name ?? "removed brand";
}

export function SyncLogTable({
  logs,
  brands,
}: {
  logs: SerializedSyncLog[];
  /** Every configured brand, to resolve a range run's brandId to a name (see brandBadgeLabel). */
  brands: Array<{ id: string; name: string }>;
}) {
  if (logs.length === 0) {
    return (
      <p className="text-muted-foreground py-8 text-center text-sm">
        No sync runs yet. Start a sync to populate the archive.
      </p>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Kind</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Started</TableHead>
          <TableHead>Duration</TableHead>
          <TableHead>Pages</TableHead>
          <TableHead className="text-right">Conversations</TableHead>
          <TableHead className="text-right">Messages</TableHead>
          <TableHead>Error</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {logs.map((log) => {
          const pagesCell = formatPagesCell(log, brands);
          return (
          <TableRow key={log.id}>
            <TableCell className="font-medium">
              <div className="flex items-center gap-1.5">
                <span className="capitalize">{log.kind}</span>
                {log.kind === "range" && (
                  <Badge
                    variant="outline"
                    className="text-muted-foreground px-1.5 py-0 text-[10px] font-normal"
                  >
                    {brandBadgeLabel(log.brandId, brands)}
                  </Badge>
                )}
              </div>
            </TableCell>
            <TableCell>
              <StatusBadge status={log.status} />
            </TableCell>
            {/* Local-timezone formatting differs between server and browser;
                suppress the expected hydration diff on this cell. */}
            <TableCell
              className="text-muted-foreground tabular-nums"
              suppressHydrationWarning
            >
              {formatStarted(log.startedAt)}
            </TableCell>
            <TableCell className="text-muted-foreground tabular-nums">
              {formatDuration(log.startedAt, log.finishedAt)}
            </TableCell>
            <TableCell className="text-muted-foreground tabular-nums">
              <span
                title={pagesCell.title}
                className="block max-w-56 truncate"
              >
                {pagesCell.text}
              </span>
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {numberFormat.format(log.conversationsSynced)}
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {numberFormat.format(log.messagesSynced)}
            </TableCell>
            <TableCell>
              {log.error ? (
                <span
                  title={log.error}
                  className="text-destructive block max-w-56 truncate"
                >
                  {log.error}
                </span>
              ) : (
                <span className="text-muted-foreground">—</span>
              )}
            </TableCell>
          </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
