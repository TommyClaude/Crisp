import type { Metadata } from "next";
import { Inbox } from "lucide-react";

import {
  ConversationRow,
  type ConversationRowItem,
} from "@/components/conversations/conversation-row";
import { ConversationFilters } from "@/components/conversations/filters";
import { JunkScanControl } from "@/components/conversations/junk-scan-control";
import { ListPagination } from "@/components/conversations/list-pagination";
import { CrispTabs } from "@/components/crisp/crisp-tabs";
import { getFilterOptions, listConversations } from "@/lib/conversations";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Conversations" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function first(value: string | string[] | undefined): string | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  return v || undefined;
}

function parseDate(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

export default async function ConversationsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const sp = await searchParams;

  const [result, options] = await Promise.all([
    listConversations({
      page: Math.max(1, Number(first(sp.page)) || 1),
      state: first(sp.state),
      tag: first(sp.tag),
      product: first(sp.product),
      brandId: first(sp.brandId),
      email: first(sp.email),
      operatorId: first(sp.operatorId),
      hasAttachment: first(sp.hasAttachment) === "true" ? true : undefined,
      dateFrom: parseDate(first(sp.dateFrom)),
      dateTo: parseDate(first(sp.dateTo)),
      search: first(sp.search),
      preview: first(sp.preview),
      junk: first(sp.junk) === "hide" || first(sp.junk) === "only"
        ? (first(sp.junk) as "hide" | "only")
        : undefined,
    }),
    getFilterOptions(),
  ]);

  const items: ConversationRowItem[] = result.items.map((c) => ({
    id: c.id,
    sessionId: c.sessionId,
    state: c.state,
    visitorEmail: c.visitorEmail,
    visitorNickname: c.visitorNickname,
    visitorAvatar: c.visitorAvatar,
    country: c.country,
    city: c.city,
    tags: c.tags,
    lastMessageAt: c.lastMessageAt?.toISOString() ?? null,
    lastMessagePreview: c.lastMessagePreview,
    updatedAtCrisp: c.updatedAtCrisp?.toISOString() ?? null,
    createdAtCrisp: c.createdAtCrisp?.toISOString() ?? null,
    isJunk: c.isJunk,
    junkReason: c.junkReason,
    assignedOperator: c.assignedOperator,
    _count: c._count,
  }));

  return (
    <div className="mx-auto w-full max-w-7xl px-6 py-8">
      <header className="mb-6 space-y-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Crisp</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            {result.total.toLocaleString("en-US")}{" "}
            {result.total === 1 ? "archived conversation" : "archived conversations"}
          </p>
        </div>
        <CrispTabs />
      </header>

      <div className="flex flex-col gap-6 md:flex-row md:items-start">
        <aside className="w-full shrink-0 space-y-4 md:w-64">
          <JunkScanControl />
          <ConversationFilters
            states={options.states}
            tags={options.tags}
            operators={options.operators}
            brands={options.brands}
            products={options.products}
          />
        </aside>

        <section className="min-w-0 flex-1 space-y-4">
          {items.length === 0 ? (
            <div className="bg-card flex flex-col items-center justify-center rounded-lg border px-6 py-16 text-center">
              <Inbox className="text-muted-foreground/50 size-10" aria-hidden />
              <h2 className="mt-4 text-sm font-semibold">
                No conversations match
              </h2>
              <p className="text-muted-foreground mt-1 max-w-sm text-sm">
                Adjust the filters, or run a sync from the Dashboard to import
                conversations from Crisp.
              </p>
            </div>
          ) : (
            <div className="divide-border bg-card divide-y overflow-hidden rounded-lg border">
              {items.map((item) => (
                <ConversationRow key={item.id} item={item} />
              ))}
            </div>
          )}

          {result.total > 0 ? (
            <ListPagination
              page={result.page}
              totalPages={result.totalPages}
              total={result.total}
            />
          ) : null}
        </section>
      </div>
    </div>
  );
}
