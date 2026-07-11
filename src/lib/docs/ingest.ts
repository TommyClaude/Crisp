import { createHash } from "crypto";
import { prisma } from "@/lib/db";
import { embeddingsConfigured } from "@/env";
import { embedTexts } from "@/lib/rag/embeddings";
import { redactText } from "@/lib/rag/redact";
import { storeChunkEmbeddings } from "@/lib/rag/search";
import { crawlForum, isWpOrgForumUrl } from "@/lib/wporg/forum-crawler";
import { crawlDocs } from "./crawler";

/**
 * Docs ingestion: crawl a DocsSource, store pages, and (re)build their RAG
 * chunks. Unchanged pages (same content hash) keep their existing chunks and
 * embeddings; removed pages are deleted. Chunks are tagged with
 * source="plugin_docs" + pluginId so RAG search can mix or separate
 * documentation and historical conversations.
 *
 * Sources of type "wporg_forum" are the plugin's wp.org support forum: each
 * answered thread becomes one DocsPage whose contentText is a Q&A transcript,
 * and its chunks carry source="wporg_forum" so the assistant can cite past
 * forum answers separately from documentation. Forum history accumulates —
 * threads that scroll past the crawl horizon on later runs are kept, not
 * deleted (unlike docs pages that disappear from a site).
 */

export interface IngestResult {
  docsSourceId: string;
  pages: number;
  pagesChanged: number;
  pagesRemoved: number;
  chunks: number;
  embedded: boolean;
}

/** Target chunk body size in characters (~400 tokens). */
const MAX_CHUNK_CHARS = 1800;

const globalForIngest = globalThis as unknown as {
  docsIngestRunning?: Set<string>;
};

function runningSet(): Set<string> {
  globalForIngest.docsIngestRunning ??= new Set();
  return globalForIngest.docsIngestRunning;
}

export function isIngestRunning(docsSourceId: string): boolean {
  return runningSet().has(docsSourceId);
}

/** Split docs text into chunk bodies on paragraph boundaries. */
export function splitDocsText(text: string, maxChars = MAX_CHUNK_CHARS): string[] {
  const paragraphs = text.split(/\n{2,}/);
  const chunks: string[] = [];
  let buffer = "";
  const flush = () => {
    const trimmed = buffer.trim();
    if (trimmed.length > 0) chunks.push(trimmed);
    buffer = "";
  };
  for (const paragraph of paragraphs) {
    if (paragraph.length > maxChars) {
      flush();
      for (let i = 0; i < paragraph.length; i += maxChars) {
        chunks.push(paragraph.slice(i, i + maxChars).trim());
      }
      continue;
    }
    if (buffer.length + paragraph.length + 2 > maxChars) flush();
    buffer = buffer ? `${buffer}\n\n${paragraph}` : paragraph;
  }
  flush();
  return chunks;
}

function contentHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export async function ingestDocsSource(
  docsSourceId: string,
  options?: { withEmbeddings?: boolean }
): Promise<IngestResult> {
  if (runningSet().has(docsSourceId)) {
    throw new Error("An ingest is already running for this docs source");
  }
  runningSet().add(docsSourceId);

  const source = await prisma.docsSource.findUniqueOrThrow({
    where: { id: docsSourceId },
    include: { plugin: { select: { id: true, name: true } } },
  });

  // Auto-heal: a wp.org forum URL added as a plain "url" source would crawl
  // the listing chrome instead of the threads — upgrade it to the forum type.
  let sourceType = source.type;
  if (sourceType !== "wporg_forum" && isWpOrgForumUrl(source.url)) {
    sourceType = "wporg_forum";
  }
  const isForum = sourceType === "wporg_forum";
  const typeJustFlipped = sourceType !== source.type;

  await prisma.docsSource.update({
    where: { id: docsSourceId },
    data: { status: "crawling", error: null, type: sourceType },
  });

  // A source that just flipped from a docs "url" crawl to "wporg_forum" still
  // holds DocsPages for the old listing chrome (/reviews/, /page/2/, ...).
  // Forum ingest never prunes stale pages, so drop them now (cascading their
  // plugin_docs chunks) — otherwise they'd linger forever and inflate counts.
  if (isForum && typeJustFlipped) {
    await prisma.docsPage.deleteMany({ where: { docsSourceId } });
  }

  try {
    const crawled = isForum
      ? await crawlForum(source.url)
      : await crawlDocs(source.url, source.type === "sitemap" ? "sitemap" : "url");
    if (crawled.length === 0) {
      throw new Error(
        isForum
          ? "No answered forum threads found — check the URL points at a wp.org plugin support forum."
          : "Crawl returned no indexable pages — check the URL (and that the site serves HTML)."
      );
    }

    let pagesChanged = 0;
    const embedTargets: Array<{ id: string; chunkText: string }> = [];
    // Pages (re)built this run — if embedding fails at the end, their content
    // hashes are cleared so the next ingest re-processes and re-embeds them
    // instead of skipping them as "unchanged" (leaving them unsearchable).
    const changedPageIds: string[] = [];

    for (const page of crawled) {
      const hash = contentHash(page.contentText);
      const existing = await prisma.docsPage.findUnique({
        where: { docsSourceId_url: { docsSourceId, url: page.url } },
        select: { id: true, contentHash: true },
      });

      if (existing && existing.contentHash === hash) {
        await prisma.docsPage.update({
          where: { id: existing.id },
          data: { lastCrawledAt: new Date(), title: page.title },
        });
        continue;
      }
      pagesChanged += 1;

      const dbPage = existing
        ? await prisma.docsPage.update({
            where: { id: existing.id },
            data: {
              title: page.title,
              contentText: page.contentText,
              contentHash: hash,
              lastCrawledAt: new Date(),
            },
          })
        : await prisma.docsPage.create({
            data: {
              docsSourceId,
              url: page.url,
              title: page.title,
              contentText: page.contentText,
              contentHash: hash,
            },
          });

      changedPageIds.push(dbPage.id);

      const headerKind = isForum ? "Forum Q&A" : "Docs";
      // Forum thread titles are user-authored and can carry PII (emails in the
      // subject line), so redact the title before it enters the chunk header
      // or the searchable `topic` column — same rule as the body.
      const safeTitle = page.title ? redactText(page.title) : null;
      const header = `[${headerKind}: ${source.plugin.name}${safeTitle ? ` | ${safeTitle}` : ""} | ${page.url}]`;
      const bodies = splitDocsText(page.contentText);
      const created = await prisma.$transaction(async (tx) => {
        await tx.embeddingChunk.deleteMany({ where: { docsPageId: dbPage.id } });
        if (bodies.length === 0) {
          return [] as Array<{ id: string; chunkText: string }>;
        }
        return tx.embeddingChunk.createManyAndReturn({
          data: bodies.map((body, index) => ({
            source: isForum ? "wporg_forum" : "plugin_docs",
            pluginId: source.plugin.id,
            docsPageId: dbPage.id,
            chunkIndex: index,
            chunkText: `${header}\n${redactText(body)}`,
            product: source.plugin.name,
            topic: safeTitle,
            rawJson: { url: page.url },
          })),
          select: { id: true, chunkText: true },
        });
      });
      embedTargets.push(...created);
    }

    // Pages that disappeared from the docs site (cascades their chunks).
    // Forum sources skip this: the crawl only reaches the newest N threads,
    // and older ingested threads remain valid knowledge.
    const removed = isForum
      ? { count: 0 }
      : await prisma.docsPage.deleteMany({
          where: {
            docsSourceId,
            url: { notIn: crawled.map((p) => p.url) },
          },
        });

    const wantEmbeddings = options?.withEmbeddings ?? true;
    let embedded = false;
    if (wantEmbeddings && embeddingsConfigured() && embedTargets.length > 0) {
      try {
        const vectors = await embedTexts(embedTargets.map((t) => t.chunkText));
        await storeChunkEmbeddings(
          embedTargets.map((t) => t.id),
          vectors
        );
        embedded = true;
      } catch (error) {
        // Chunks are committed but un-embedded; clear the changed pages' hashes
        // so re-ingest reprocesses them rather than treating them as unchanged.
        await prisma.docsPage.updateMany({
          where: { id: { in: changedPageIds } },
          data: { contentHash: "" },
        });
        throw error;
      }
    }

    const chunkCount = await prisma.embeddingChunk.count({
      where: { docsPage: { docsSourceId } },
    });
    // Forum history accumulates across runs, so count stored threads rather
    // than this run's crawl window.
    const pageCount = isForum
      ? await prisma.docsPage.count({ where: { docsSourceId } })
      : crawled.length;
    await prisma.docsSource.update({
      where: { id: docsSourceId },
      data: {
        status: "completed",
        lastCrawledAt: new Date(),
        pageCount,
        chunkCount,
        error: null,
      },
    });

    return {
      docsSourceId,
      pages: pageCount,
      pagesChanged,
      pagesRemoved: removed.count,
      chunks: chunkCount,
      embedded,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await prisma.docsSource.update({
      where: { id: docsSourceId },
      data: { status: "failed", error: message.slice(0, 1000) },
    });
    throw error;
  } finally {
    runningSet().delete(docsSourceId);
  }
}
