import type { Metadata } from "next";
import type { SyncLog } from "@prisma/client";
import {
  Building2,
  CircleCheckBig,
  MessageSquareText,
  MessagesSquare,
} from "lucide-react";

import { BrandSelector } from "@/components/dashboard/brand-selector";
import { CrispTabs } from "@/components/crisp/crisp-tabs";
import {
  CrispSyncDashboard,
  type CoverageView,
} from "@/components/dashboard/crisp-sync-dashboard";
import type { SerializedSyncLog } from "@/components/dashboard/sync-log-table";
import {
  Card,
  CardAction,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { prisma } from "@/lib/db";
import { getDashboardStats } from "@/lib/conversations";
import { getArchiveCoverage } from "@/lib/sync/coverage-query";
import { getResumePage } from "@/lib/sync/sync-service";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Crisp",
};

const numberFormat = new Intl.NumberFormat("en-US");

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function first(value: string | string[] | undefined): string | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  return v || undefined;
}

function serializeSyncLog(log: SyncLog): SerializedSyncLog {
  return {
    id: log.id,
    kind: log.kind,
    status: log.status,
    startedAt: log.startedAt.toISOString(),
    finishedAt: log.finishedAt?.toISOString() ?? null,
    pageFrom: log.pageFrom,
    pageTo: log.pageTo,
    conversationsSynced: log.conversationsSynced,
    messagesSynced: log.messagesSynced,
    failedSessions: log.failedSessions,
    error: log.error,
    brandId: log.brandId,
  };
}

interface StatCard {
  label: string;
  value: number;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
}

/**
 * Build the Archive coverage section's data for the given selection — see
 * CoverageView's doc comment for why this is never a single grid merged
 * across brands. Runs 1 or `brands.length` getArchiveCoverage queries
 * (2-3 in practice), all in parallel.
 */
async function buildCoverageView(
  brands: Array<{ id: string; name: string }>,
  selectedBrandId: string | undefined
): Promise<CoverageView> {
  if (selectedBrandId) {
    const brand = brands.find((b) => b.id === selectedBrandId)!;
    const data = await getArchiveCoverage({ brandId: selectedBrandId });
    return { mode: "single", brandId: brand.id, brandName: brand.name, data };
  }
  if (brands.length > 0) {
    const perBrand = await Promise.all(
      brands.map(async (brand) => ({
        brandId: brand.id,
        brandName: brand.name,
        data: await getArchiveCoverage({ brandId: brand.id }),
      }))
    );
    return { mode: "stacked", brands: perBrand };
  }
  // Legacy env-only fallback: no Brand rows configured, so there is nothing
  // to scope by — the one merged grid is the correct (and only) view.
  const data = await getArchiveCoverage();
  return { mode: "merged", data };
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const [sp, brands] = await Promise.all([
    searchParams,
    prisma.brand.findMany({
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
  ]);

  const brandParam = first(sp.brand);
  const selectedBrandId = brands.some((b) => b.id === brandParam)
    ? brandParam
    : undefined;

  const [stats, resumePage, coverageView] = await Promise.all([
    getDashboardStats({ brandId: selectedBrandId }),
    getResumePage(),
    buildCoverageView(brands, selectedBrandId),
  ]);

  // Run-centric sync progress/logs are deliberately global (not brand-scoped)
  // — a SyncLog row describes a JOB, and full/incremental runs always cover
  // every brand regardless of which brand is selected in the UI right now.
  const lastSync = stats.lastSync
    ? {
        finishedAt: stats.lastSync.finishedAt?.toISOString() ?? null,
        status: stats.lastSync.status,
        kind: stats.lastSync.kind,
        conversationsSynced: stats.lastSync.conversationsSynced,
        messagesSynced: stats.lastSync.messagesSynced,
      }
    : null;
  const recentLogs = stats.recentLogs.map(serializeSyncLog);

  const resolvedPct =
    stats.totalConversations > 0
      ? Math.round((stats.resolvedCount / stats.totalConversations) * 100)
      : 0;

  const statCards: StatCard[] = [
    {
      label: "Total conversations",
      value: stats.totalConversations,
      description: "Archived from Crisp",
      icon: MessagesSquare,
    },
    {
      label: "Total messages",
      value: stats.totalMessages,
      description: "Across all conversations",
      icon: MessageSquareText,
    },
    {
      label: "Resolved conversations",
      value: stats.resolvedCount,
      description: `${resolvedPct}% of archive`,
      icon: CircleCheckBig,
    },
    {
      label: "Brands",
      value: stats.brandCount,
      description: "Crisp websites being synced",
      icon: Building2,
    },
  ];

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6 lg:p-8">
      <header className="space-y-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Crisp</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Conversation archive from your Crisp websites — one of the
            knowledge sources behind answer suggestions.
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CrispTabs />
          {brands.length > 0 && (
            <BrandSelector brands={brands} selectedBrandId={selectedBrandId} />
          )}
        </div>
      </header>

      <section
        aria-label="Archive statistics"
        className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4"
      >
        {statCards.map(({ label, value, description, icon: Icon }) => (
          <Card key={label} className="gap-3">
            <CardHeader>
              <CardDescription>{label}</CardDescription>
              <CardTitle className="text-3xl font-semibold tabular-nums">
                {numberFormat.format(value)}
              </CardTitle>
              <CardAction>
                <span className="bg-muted text-muted-foreground flex size-9 items-center justify-center rounded-lg">
                  <Icon className="size-4" />
                </span>
              </CardAction>
              <p className="text-muted-foreground text-xs">{description}</p>
            </CardHeader>
          </Card>
        ))}
      </section>

      {/* Remounted on brand change (key) so no per-brand click state (the
          heatmap's month-click prefill) survives a brand switch — see
          CrispSyncDashboard's doc comment. */}
      <CrispSyncDashboard
        key={selectedBrandId ?? "all"}
        coverageView={coverageView}
        brands={brands}
        selectedBrandId={selectedBrandId}
        lastSync={lastSync}
        recentLogs={recentLogs}
        resumePage={resumePage}
      />
    </div>
  );
}
