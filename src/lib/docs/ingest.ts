import { createHash } from "crypto";
import { prisma } from "@/lib/db";
import { embeddingsConfigured } from "@/env";
import { embedTexts } from "@/lib/rag/embeddings";
import { redactText } from "@/lib/rag/redact";
import { storeChunkEmbeddings } from "@/lib/rag/search";
import { crawlDocs } from "./crawler";

/**
 * Docs ingestion: crawl a DocsSource, store pages, and (re)build their RAG
 * chunks. Unchanged pages (same content hash) keep their existing chunks and
 * embeddings; removed pages are deleted. Chunks are tagged with
 * source="plugin_docs" + pluginId so RAG search can mix or separate
 * documentation and historical conversations.
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
  await prisma.docsSource.update({
    where: { id: docsSourceId },
    data: { status: "crawling", error: null },
  });

  try {
    const crawled = await crawlDocs(
      source.url,
      source.type === "sitemap" ? "sitemap" : "url"
    );
    if (crawled.length === 0) {
      throw new Error(
        "Crawl returned no indexable pages — check the URL (and that the site serves HTML)."
      );
    }

    let pagesChanged = 0;
    const embedTargets: Array<{ id: string; chunkText: string }> = [];

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

      const header = `[Docs: ${source.plugin.name}${page.title ? ` | ${page.title}` : ""} | ${page.url}]`;
      const bodies = splitDocsText(page.contentText);
      const created = await prisma.$transaction(async (tx) => {
        await tx.embeddingChunk.deleteMany({ where: { docsPageId: dbPage.id } });
        if (bodies.length === 0) {
          return [] as Array<{ id: string; chunkText: string }>;
        }
        return tx.embeddingChunk.createManyAndReturn({
          data: bodies.map((body, index) => ({
            source: "plugin_docs",
            pluginId: source.plugin.id,
            docsPageId: dbPage.id,
            chunkIndex: index,
            chunkText: `${header}\n${redactText(body)}`,
            product: source.plugin.name,
            topic: page.title,
            rawJson: { url: page.url },
          })),
          select: { id: true, chunkText: true },
        });
      });
      embedTargets.push(...created);
    }

    // Pages that disappeared from the docs site (cascades their chunks).
    const removed = await prisma.docsPage.deleteMany({
      where: {
        docsSourceId,
        url: { notIn: crawled.map((p) => p.url) },
      },
    });

    const wantEmbeddings = options?.withEmbeddings ?? true;
    let embedded = false;
    if (wantEmbeddings && embeddingsConfigured() && embedTargets.length > 0) {
      const vectors = await embedTexts(embedTargets.map((t) => t.chunkText));
      await storeChunkEmbeddings(
        embedTargets.map((t) => t.id),
        vectors
      );
      embedded = true;
    }

    const chunkCount = await prisma.embeddingChunk.count({
      where: { docsPage: { docsSourceId } },
    });
    await prisma.docsSource.update({
      where: { id: docsSourceId },
      data: {
        status: "completed",
        lastCrawledAt: new Date(),
        pageCount: crawled.length,
        chunkCount,
        error: null,
      },
    });

    return {
      docsSourceId,
      pages: crawled.length,
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
