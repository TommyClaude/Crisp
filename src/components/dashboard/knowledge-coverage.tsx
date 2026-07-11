import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
import {
  ArrowRight,
  BookOpen,
  LifeBuoy,
  MessagesSquare,
  TriangleAlert,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import type {
  RebuildAdvice,
  RebuildAdviceReasonCode,
} from "@/lib/rag/rebuild-advice";
import type { KnowledgeCoverage, KnowledgeCoverageFailure } from "@/lib/stats";

/** Short forms of each staleness reason for the compact dashboard line. */
const REBUILD_REASON_SHORT: Record<RebuildAdviceReasonCode, string> = {
  defs_changed: "plugin or keyword definitions changed",
  rules_updated: "chunk-building rules updated",
  never_recorded: "no full rebuild recorded yet",
};

/**
 * "Knowledge coverage" — the dashboard's at-a-glance answer to "has
 * everything been chunked and embedded, and was anything missed?" for the
 * three RAG sources (Crisp chats, crawled docs, ingested forum Q&A).
 *
 * Server-rendered snapshot: the dashboard page is `force-dynamic`, so this
 * re-reads the DB on every load — no client polling needed.
 */

const numberFormat = new Intl.NumberFormat("en-US");
function fmt(n: number): string {
  return numberFormat.format(n);
}

/** "N chunks (all embedded)" / "N chunks (M embedded)" / "0 chunks". */
function chunksPhrase(chunks: number, embedded: number): string {
  if (chunks === 0) return "0 chunks";
  if (embedded >= chunks) return `${fmt(chunks)} chunks (all embedded)`;
  return `${fmt(chunks)} chunks (${fmt(embedded)} embedded)`;
}

function AmberLine({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-1 flex items-start gap-1.5 text-amber-600 dark:text-amber-400">
      <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

function FailedSourceLines({
  failures,
}: {
  failures: KnowledgeCoverageFailure[];
}) {
  if (failures.length === 0) return null;
  return (
    <>
      {failures.map((source) => (
        <p
          key={source.id}
          className="text-destructive mt-1 flex items-start gap-1.5"
        >
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
          <span className="min-w-0">
            <span className="font-medium">{source.name}</span> failed
            {source.error ? (
              <>
                {" — "}
                <span title={source.error}>{source.error}</span>
              </>
            ) : null}
          </span>
        </p>
      ))}
    </>
  );
}

function SourceSection({
  icon: Icon,
  title,
  href,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  href: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-center justify-between">
        <p className="flex items-center gap-2 text-sm font-medium">
          <Icon className="text-muted-foreground size-4" />
          {title}
        </p>
        <Button asChild variant="ghost" size="sm" className="h-7 px-2 text-xs">
          <Link href={href}>
            Open
            <ArrowRight className="size-3" />
          </Link>
        </Button>
      </div>
      <div className="text-muted-foreground mt-2 space-y-1 text-xs">
        {children}
      </div>
    </div>
  );
}

export function KnowledgeCoveragePanel({
  coverage,
  lastSyncAt,
  rebuildAdvice,
}: {
  coverage: KnowledgeCoverage;
  /** finishedAt of the last completed Crisp sync (freshness of the chats source). */
  lastSyncAt?: Date | null;
  /** "Rebuild recommended" staleness signal for the chat-chunk index. */
  rebuildAdvice?: RebuildAdvice;
}) {
  const { chats, docs, forum, embeddingsConfigured, pgvectorActive } =
    coverage;

  const chatGapWarn = embeddingsConfigured && chats.chunks > chats.chunksEmbedded;
  const docsGapWarn = embeddingsConfigured && docs.chunks > docs.chunksEmbedded;
  const forumGapWarn = embeddingsConfigured && forum.chunks > forum.chunksEmbedded;

  const searchCapability = !embeddingsConfigured
    ? { label: "keyword-only — set OPENAI_API_KEY", amber: true }
    : pgvectorActive
      ? { label: "vector (pgvector)", amber: false }
      : { label: "hybrid (JSON embeddings)", amber: false };

  return (
    <Card className="lg:col-span-2">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <BookOpen className="text-muted-foreground size-4" />
          Knowledge coverage
        </CardTitle>
        <CardDescription>
          What&apos;s been chunked and embedded for the suggester — and what
          was missed.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <SourceSection
          icon={MessagesSquare}
          title="Chats"
          href="/crisp/dashboard"
        >
          <p>
            <span className="text-foreground tabular-nums">
              {fmt(chats.resolvedCount)}
            </span>{" "}
            resolved →{" "}
            <span className="text-foreground tabular-nums">
              {fmt(chats.conversationsWithChunks)}
            </span>{" "}
            indexed · {chunksPhrase(chats.chunks, chats.chunksEmbedded)}
          </p>
          <p className="text-muted-foreground/80">
            Gap is expected — unresolved-at-sync, filtered noise, or pending
            rebuild.
          </p>
          {lastSyncAt ? (
            <p suppressHydrationWarning>
              Last sync{" "}
              {formatDistanceToNow(lastSyncAt, { addSuffix: true })}
            </p>
          ) : null}
          {chatGapWarn && (
            <AmberLine>
              {fmt(chats.chunks - chats.chunksEmbedded)} chunk
              {chats.chunks - chats.chunksEmbedded === 1 ? "" : "s"} not yet
              embedded
            </AmberLine>
          )}
          {rebuildAdvice?.needsRebuild && rebuildAdvice.reasons[0] && (
            <AmberLine>
              <Link href="/rag" className="hover:underline">
                Rebuild recommended —{" "}
                {REBUILD_REASON_SHORT[rebuildAdvice.reasons[0].code]}
              </Link>
            </AmberLine>
          )}
        </SourceSection>

        <Separator />

        <SourceSection icon={BookOpen} title="Documentation" href="/plugins">
          <p>
            {fmt(docs.sourceCount)} source{docs.sourceCount === 1 ? "" : "s"}{" "}
            · {fmt(docs.totalPages)} page{docs.totalPages === 1 ? "" : "s"} ·{" "}
            {chunksPhrase(docs.chunks, docs.chunksEmbedded)}
          </p>
          {docsGapWarn && (
            <AmberLine>
              {fmt(docs.chunks - docs.chunksEmbedded)} chunk
              {docs.chunks - docs.chunksEmbedded === 1 ? "" : "s"} not yet
              embedded
            </AmberLine>
          )}
          {docs.capHit.map((source) => (
            <AmberLine key={source.id}>
              <span className="font-medium">{source.name}</span> hit the{" "}
              {docs.pageCrawlCap}-page crawl cap ({fmt(source.pageCount)}{" "}
              pages) — there may be more uncrawled pages
            </AmberLine>
          ))}
          <FailedSourceLines failures={docs.failedSources} />
        </SourceSection>

        <Separator />

        <SourceSection icon={LifeBuoy} title="Forum Q&A" href="/plugins">
          <p>
            {fmt(forum.sourceCount)} source{forum.sourceCount === 1 ? "" : "s"}{" "}
            · {fmt(forum.totalTopics)} topic
            {forum.totalTopics === 1 ? "" : "s"} ·{" "}
            {chunksPhrase(forum.chunks, forum.chunksEmbedded)}
          </p>
          <p className="text-muted-foreground/80">
            Each ingest run covers the newest {forum.topicsPerIngestCap}{" "}
            answered topics per source.
          </p>
          {forumGapWarn && (
            <AmberLine>
              {fmt(forum.chunks - forum.chunksEmbedded)} chunk
              {forum.chunks - forum.chunksEmbedded === 1 ? "" : "s"} not yet
              embedded
            </AmberLine>
          )}
          <FailedSourceLines failures={forum.failedSources} />
        </SourceSection>

        <Separator />

        <p className="text-muted-foreground text-xs">
          Semantic search:{" "}
          {searchCapability.amber ? (
            <span className="text-amber-600 dark:text-amber-400 inline-flex items-center gap-1">
              <TriangleAlert className="size-3.5" />
              {searchCapability.label}
            </span>
          ) : (
            <span className="text-foreground">{searchCapability.label}</span>
          )}
        </p>
      </CardContent>
    </Card>
  );
}
