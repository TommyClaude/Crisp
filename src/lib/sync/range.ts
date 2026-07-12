import { z } from "zod";

/**
 * A `YYYY-MM-DD` calendar date. Format is checked by the regex; `refine`
 * rejects impossible dates that pass the shape check. The round-trip
 * comparison (parse as UTC, format back, compare) is required because
 * Date.parse alone rolls day-of-month overflow forward instead of failing —
 * "2024-02-30" parses as 2024-03-01, which would silently sync a different
 * window than the one requested.
 */
export const isoDay = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected an ISO date (YYYY-MM-DD)")
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return (
      !Number.isNaN(parsed.getTime()) &&
      parsed.toISOString().slice(0, 10) === value
    );
  }, "Not a real calendar date");

/**
 * Convert a validated `YYYY-MM-DD` pair to an inclusive UTC window:
 * start-of-day for `dateStart`, end-of-day for `dateEnd`. UTC on purpose — the
 * coverage heatmap buckets by UTC month (Postgres EXTRACT on the stored UTC
 * timestamp), so the window the owner clicks lines up exactly with the cells.
 */
export function toDateWindow(
  dateStart: string,
  dateEnd: string
): { start: Date; end: Date } {
  return {
    start: new Date(`${dateStart}T00:00:00.000Z`),
    end: new Date(`${dateEnd}T23:59:59.999Z`),
  };
}

export type RangeValidation =
  | { ok: true; window: { start: Date; end: Date } | null }
  | { ok: false; message: string };

/**
 * Cross-field validation for the optional date range on the sync-start body.
 * Enforces both-or-neither and start <= end, and returns the resolved UTC
 * window when a range was requested (or `window: null` for a non-range run).
 * Kept as a plain function (not a Zod refinement) so it's trivially unit
 * testable and the route can return a specific 400 message.
 */
export function validateRange(
  dateStart?: string,
  dateEnd?: string
): RangeValidation {
  // Empty strings count as provided-but-invalid (the isoDay check below
  // rejects them), matching the route, which 400s "" at its Zod layer — the
  // two validation layers must agree so direct callers see the same contract.
  const hasStart = dateStart != null;
  const hasEnd = dateEnd != null;

  if (hasStart !== hasEnd) {
    return {
      ok: false,
      message: "Provide both dateStart and dateEnd, or neither.",
    };
  }
  if (!hasStart) return { ok: true, window: null };

  // Defensive re-check for direct callers that bypass the route's isoDay parse.
  for (const [name, value] of [
    ["dateStart", dateStart],
    ["dateEnd", dateEnd],
  ] as const) {
    if (!isoDay.safeParse(value).success) {
      return { ok: false, message: `${name} must be an ISO date (YYYY-MM-DD).` };
    }
  }
  // Lexicographic comparison of YYYY-MM-DD equals chronological order.
  if (dateStart! > dateEnd!) {
    return { ok: false, message: "dateStart must be on or before dateEnd." };
  }
  return { ok: true, window: toDateWindow(dateStart!, dateEnd!) };
}
