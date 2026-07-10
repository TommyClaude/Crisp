import type { Metadata } from "next";
import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
import {
  ArrowRight,
  BookOpen,
  Inbox,
  Lightbulb,
  MessagesSquare,
  Sparkles,
} from "lucide-react";

import { ThreadStatusBadge } from "@/components/state-badge";
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
import { Separator } from "@/components/ui/separator";
import { getGlobalStats } from "@/lib/stats";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Dashboard",
};

const numberFormat = new Intl.NumberFormat("en-US");

export default async function GlobalDashboardPage() {
  const stats = await getGlobalStats();
  const needsAttention =
    (stats.threadsByStatus.new ?? 0) + (stats.threadsByStatus.failed ?? 0);

  const statCards = [
    {
      label: "Open threads",
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
      description: "Threads handled by the team",
      icon: Sparkles,
    },
    {
      label: "Knowledge chunks",
      value: stats.totalChunks,
      description: `${numberFormat.format(stats.chunksBySource.crisp_chat ?? 0)} from chats · ${numberFormat.format(stats.chunksBySource.plugin_docs ?? 0)} from docs`,
      icon: BookOpen,
    },
  ];

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6 lg:p-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Tickets and threads across your plugins, and the knowledge powering
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
              Latest forum threads
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
                No threads yet — add wp.org slugs to your plugins and run a
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
                      <ThreadStatusBadge status={thread.status} />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        {/* Knowledge sources */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <BookOpen className="text-muted-foreground size-4" />
              Knowledge sources
            </CardTitle>
            <CardDescription>
              What the suggester has learned from.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <div className="flex items-center justify-between">
                <p className="flex items-center gap-2 text-sm font-medium">
                  <MessagesSquare className="text-muted-foreground size-4" />
                  Crisp conversations
                </p>
                <Button asChild variant="ghost" size="sm" className="h-7 px-2 text-xs">
                  <Link href="/crisp/dashboard">
                    Open
                    <ArrowRight className="size-3" />
                  </Link>
                </Button>
              </div>
              <dl className="text-muted-foreground mt-2 space-y-1 text-xs">
                <div className="flex justify-between">
                  <dt>Conversations</dt>
                  <dd className="text-foreground tabular-nums">
                    {numberFormat.format(stats.conversationCount)}
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt>Messages</dt>
                  <dd className="text-foreground tabular-nums">
                    {numberFormat.format(stats.messageCount)}
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt>Last sync</dt>
                  <dd className="text-foreground" suppressHydrationWarning>
                    {stats.lastSync?.finishedAt
                      ? formatDistanceToNow(stats.lastSync.finishedAt, {
                          addSuffix: true,
                        })
                      : "never"}
                  </dd>
                </div>
              </dl>
            </div>

            <Separator />

            <div>
              <div className="flex items-center justify-between">
                <p className="flex items-center gap-2 text-sm font-medium">
                  <BookOpen className="text-muted-foreground size-4" />
                  Documentation
                </p>
                <Button asChild variant="ghost" size="sm" className="h-7 px-2 text-xs">
                  <Link href="/plugins">
                    Open
                    <ArrowRight className="size-3" />
                  </Link>
                </Button>
              </div>
              <dl className="text-muted-foreground mt-2 space-y-1 text-xs">
                <div className="flex justify-between">
                  <dt>Docs pages indexed</dt>
                  <dd className="text-foreground tabular-nums">
                    {numberFormat.format(stats.docsPageCount)}
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt>Plugins</dt>
                  <dd className="text-foreground tabular-nums">
                    {numberFormat.format(stats.pluginCount)}
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt>Brands</dt>
                  <dd className="text-foreground tabular-nums">
                    {numberFormat.format(stats.brandCount)}
                  </dd>
                </div>
              </dl>
            </div>
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
