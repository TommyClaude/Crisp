"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { LoaderCircle, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { HelpTip } from "@/components/help-tip";
import { Button } from "@/components/ui/button";

interface ScanResult {
  scanned: number;
  junk: number;
  byReason: Record<string, number>;
  cleaned: number;
}

const numberFormat = new Intl.NumberFormat("en-US");

/** Short labels for the classifier's stable reason strings, for the toast. */
const REASON_LABELS: Record<string, string> = {
  "automated sender": "automated sender",
  "bracketed notification subject, never answered": "notification subject",
};

/** "automated sender: 71, notification subject: 16" from the byReason map. */
function formatByReason(byReason: Record<string, number>): string {
  return Object.entries(byReason)
    .sort((a, b) => b[1] - a[1])
    .map(([reason, count]) => `${REASON_LABELS[reason] ?? reason}: ${count}`)
    .join(", ");
}

/**
 * "Scan for junk" — re-runs the heuristic classifier over every conversation
 * the auto-classifier is allowed to touch (a human's manual mark/unmark is
 * always left alone) and toasts a summary. Mirrors the dashboard's "Detect
 * archive start" control: a small button + HelpTip, a bounded server sweep,
 * and a router.refresh() so the freshly-classified badges show immediately.
 * Sits by the Filters card so the flow reads "scan → filter Junk only →
 * review".
 */
export function JunkScanControl() {
  const router = useRouter();
  const [scanning, setScanning] = React.useState(false);

  const handleScan = React.useCallback(async () => {
    setScanning(true);
    try {
      const res = await fetch("/api/crisp/junk/scan", { method: "POST" });
      if (res.status === 409) {
        const body = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        toast.error(body?.error ?? "A sync is running — try again when it finishes.");
        return;
      }
      if (!res.ok) {
        toast.error("Failed to scan for junk");
        return;
      }
      const result = (await res.json()) as ScanResult;
      const reasons = formatByReason(result.byReason);
      toast.success(
        `${numberFormat.format(result.scanned)} scanned — ${numberFormat.format(
          result.junk
        )} junk${reasons ? ` (${reasons})` : ""}`,
        {
          description:
            result.cleaned > 0
              ? `${numberFormat.format(result.cleaned)} RAG ${
                  result.cleaned === 1 ? "chunk" : "chunks"
                } removed from newly-junk conversations.`
              : "No new chunks needed removing.",
        }
      );
      router.refresh();
    } catch {
      toast.error("Failed to scan for junk");
    } finally {
      setScanning(false);
    }
  }, [router]);

  return (
    <div className="bg-card flex items-center justify-between gap-2 rounded-lg border p-3">
      <div className="flex items-center gap-1">
        <span className="text-sm font-semibold">Junk detection</span>
        <HelpTip subject="scan for junk">
          Re-classifies every conversation against the current rules —
          no-reply / notification senders, and bracketed notification subjects
          no operator ever answered — and removes any newly-junk conversation
          from the AI&rsquo;s knowledge. Conversations you marked or unmarked by
          hand are never touched. Junk stays browsable here; filter it with the
          Junk selector below.
        </HelpTip>
      </div>
      <Button
        variant="outline"
        size="sm"
        onClick={handleScan}
        disabled={scanning}
      >
        {scanning ? (
          <LoaderCircle className="size-3.5 animate-spin" />
        ) : (
          <Trash2 className="size-3.5" />
        )}
        Scan for junk
      </Button>
    </div>
  );
}
