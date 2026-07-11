import type { Metadata } from "next";
import type { SyncLog } from "@prisma/client";
import {
  Building2,
  CircleCheckBig,
  MessageSquareText,
  MessagesSquare,
} from "lucide-react";

import { CrispTabs } from "@/components/crisp/crisp-tabs";
import { SyncPanel } from "@/components/dashboard/sync-panel";
import type { SerializedSyncLog } from "@/components/dashboard/sync-log-table";
import {
  Card,
  CardAction,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { getDashboardStats } from "@/lib/conversations";
import { getResumePage } from "@/lib/sync/sync-service";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Crisp",
};

const numberFormat = new Intl.NumberFormat("en-US");

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
  };
}

interface StatCard {
  label: string;
  value: number;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
}

export default async function DashboardPage() {
  const [stats, resumePage] = await Promise.all([
    getDashboardStats(),
    getResumePage(),
  ]);

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
        <CrispTabs />
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

      <SyncPanel
        lastSync={lastSync}
        recentLogs={recentLogs}
        resumePage={resumePage}
      />
    </div>
  );
}
