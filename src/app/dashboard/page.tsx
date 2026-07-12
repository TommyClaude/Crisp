import type { Metadata } from "next";
import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
import {
  ArrowRight,
  BookOpen,
  Inbox,
  Lightbulb,
  Sparkles,
} from "lucide-react";

import { KnowledgeCoveragePanel } from "@/components/dashboard/knowledge-coverage";
import { MailListenerCard } from "@/components/dashboard/mail-listener-card";
import {
  FollowupDueBadge,
  NewReplyBadge,
  ThreadStatusBadge,
} from "@/components/state-badge";
import { getEnv } from "@/env";
import { daysSincePromise, isPromiseDue } from "@/lib/suggest/promise";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { getRebuildAdvice } from "@/lib/rag/rebuild-advice";
import { getGlobalStats, getKnowledgeCoverage } from "@/lib/stats";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Dashboard",
};

const numberFormat = new Intl.NumberFormat("en-US");

export default async function GlobalDashboardPage() {
  const [stats, coverage, rebuildAdvice] = await Promise.all([
    getGlobalStats(),
    getKnowledgeCoverage(),
    getRebuildAdvice(),
  ]);
  const needsAttention =
    (stats.threadsByStatus.new ?? 0) + (stats.threadsByStatus.failed ?? 0);
  const promiseReminderDays = getEnv().WPORG_PROMISE_REMINDER_DAYS;
  const dashboardNow = new Date();

  const statCards = [
    {
      label: "Open topics",
      value: needsAttention,
      description: "New or failed — waiting for a draft/review",
      icon: Inbox,
    },
    {
      label: "Drafts ready",
      value: stats.threadsByStatus.drafted ?? 0,
      description: "Suggested replies awaiting review",
      icon: Lightbulb,
    },
    {
      label: "Reviewed",
      value: stats.threadsByStatus.reviewed ?? 0,
      description: "Topics handled by the team",
      icon: Sparkles,
    },
    {
      label: "Knowledge chunks",
      value: stats.totalChunks,
      description: `${numberFormat.format(stats.chunksBySource.crisp_chat ?? 0)} from chats · ${numberFormat.format(stats.chunksBySource.plugin_docs ?? 0)} from docs · ${numberFormat.format(stats.chunksBySource.wporg_forum ?? 0)} from forum`,
      icon: BookOpen,
    },
  ];

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6 lg:p-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Tickets and topics across your plugins, and the knowledge powering
          the answer suggestions.
        </p>
      </header>

      <section
        aria-label="Overview statistics"
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

      <section className="grid grid-cols-1 gap-4 lg:grid-cols-5">
        {/* Recent threads — the work queue */}
        <Card className="lg:col-span-3">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Lightbulb className="text-muted-foreground size-4" />
              Latest forum topics
            </CardTitle>
            <CardDescription>
              Newest topics from the wp.org support forums of your plugins.
            </CardDescription>
            <CardAction>
              <Button asChild variant="outline" size="sm">
                <Link href="/suggestions">
                  View all
                  <ArrowRight className="size-3.5" />
                </Link>
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent>
            {stats.recentThreads.length === 0 ? (
              <p className="text-muted-foreground py-6 text-center text-sm">
                No topics yet — add wp.org slugs to your plugins and run a
                forum check from the Suggestions page.
              </p>
            ) : (
              <ul className="divide-y">
                {stats.recentThreads.map((thread) => (
                  <li key={thread.id}>
                    <Link
                      href="/suggestions"
                      className="hover:bg-muted/60 -mx-2 flex items-center gap-3 rounded-md px-2 py-2.5 transition-colors"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">
                          {thread.title}
                        </p>
                        <p className="text-muted-foreground mt-0.5 flex items-center gap-2 text-xs">
                          <Badge
                            variant="secondary"
                            className="px-1.5 py-0 text-[11px] font-normal"
                          >
                            {thread.plugin.name}
                          </Badge>
                          {thread.author ? <span>by {thread.author}</span> : null}
                          {thread.publishedAt ? (
                            <span suppressHydrationWarning>
                              {formatDistanceToNow(thread.publishedAt, {
                                addSuffix: true,
                              })}
                            </span>
                          ) : null}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5">
                        {thread.hasNewReply ? <NewReplyBadge /> : null}
                        {isPromiseDue(
                          thread.followupPromisedAt,
                          promiseReminderDays,
                          dashboardNow
                        ) ? (
                          <FollowupDueBadge
                            days={daysSincePromise(
                              thread.followupPromisedAt!,
                              dashboardNow
                            )}
                          />
                        ) : null}
                        <ThreadStatusBadge status={thread.status} />
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <div className="flex flex-col gap-4 lg:col-span-2">
          <MailListenerCard />
          <KnowledgeCoveragePanel
            coverage={coverage}
            lastSyncAt={stats.lastSync?.finishedAt ?? null}
            rebuildAdvice={rebuildAdvice}
          />
        </div>
      </section>
    </div>
  );
}
