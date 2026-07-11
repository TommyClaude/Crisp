import { formatDistanceToNow } from "date-fns";

import { prisma } from "@/lib/db";
import { CHUNKER_VERSION } from "./chunker";

/**
 * "Rebuild recommended" staleness notice for the chat-chunk RAG index.
 *
 * The full "Rebuild all chunks" job re-indexes crisp_chat chunks under the
 * CURRENT rules (chunker + product-detection definitions). Two things make the
 * existing chunks stale without any rebuild being run:
 *
 *  1. Plugin / detection-keyword definitions change (create/update/delete a
 *     plugin, or bulk-import plugins). Fresh syncs tag chunks with the new
 *     defs, but chunks built before the change keep their old product tags.
 *  2. A code release changes the chunk-building rules ({@link CHUNKER_VERSION}
 *     bumps), e.g. the noise-gate filter — older chunks were built differently.
 *
 * Regular Crisp syncs and docs/forum ingest chunk with the current rules, so
 * they never make the index stale and must not trigger this notice. State is
 * kept in a handful of {@link AppMeta} rows so the signal survives restarts.
 */

/** AppMeta keys backing the rebuild-advice bookkeeping. */
export const REBUILD_META_KEYS = {
  /** ISO timestamp of the last completed full chat-chunk rebuild. */
  chunksRebuiltAt: "chat_chunks_rebuilt_at",
  /** {@link CHUNKER_VERSION} in force at that last completed rebuild. */
  chunksRebuiltVersion: "chat_chunks_rebuilt_version",
  /** ISO timestamp product-detection definitions last changed. */
  productDefsChangedAt: "product_defs_changed_at",
} as const;

export type RebuildAdviceReasonCode =
  | "defs_changed"
  | "rules_updated"
  | "never_recorded";

export interface RebuildAdviceReason {
  code: RebuildAdviceReasonCode;
  message: string;
}

export interface RebuildAdvice {
  needsRebuild: boolean;
  reasons: RebuildAdviceReason[];
}

async function readMeta(key: string): Promise<unknown> {
  const row = await prisma.appMeta.findUnique({ where: { key } });
  return row?.value ?? null;
}

function metaUpsert(key: string, value: string | number) {
  return prisma.appMeta.upsert({
    where: { key },
    create: { key, value },
    update: { value },
  });
}

/**
 * Record that product-detection definitions changed. Call (awaited) alongside
 * every invalidateProductDefinitions() so the notice knows the on-disk chunk
 * tags may now disagree with the live plugin defs. Never throws — bookkeeping
 * must not fail the plugin mutation that triggered it; worst case the
 * staleness notice fires late.
 */
export async function touchProductDefsChanged(): Promise<void> {
  try {
    await metaUpsert(
      REBUILD_META_KEYS.productDefsChangedAt,
      new Date().toISOString()
    );
  } catch (error) {
    console.error("Failed to record product-defs change:", error);
  }
}

/**
 * Record that a full chat-chunk rebuild completed under the current rules.
 * Call only when a full rebuild finishes with status "completed" (cancelled /
 * failed runs leave the previous marker untouched). Both keys are written in
 * one transaction so a crash can't leave the timestamp/version pair split.
 */
export async function recordChunksRebuilt(): Promise<void> {
  await prisma.$transaction([
    metaUpsert(REBUILD_META_KEYS.chunksRebuiltAt, new Date().toISOString()),
    metaUpsert(REBUILD_META_KEYS.chunksRebuiltVersion, CHUNKER_VERSION),
  ]);
}

/**
 * Whether a full chat-chunk rebuild is recommended, and why. Returns at most
 * one reason per code. A fresh install with zero crisp_chat chunks never needs
 * a rebuild (there is nothing to re-index).
 */
export async function getRebuildAdvice(): Promise<RebuildAdvice> {
  const [rebuiltAtRaw, rebuiltVersionRaw, defsChangedRaw, chatChunkCount] =
    await Promise.all([
      readMeta(REBUILD_META_KEYS.chunksRebuiltAt),
      readMeta(REBUILD_META_KEYS.chunksRebuiltVersion),
      readMeta(REBUILD_META_KEYS.productDefsChangedAt),
      prisma.embeddingChunk.count({ where: { source: "crisp_chat" } }),
    ]);

  // Nothing indexed yet — a fresh install has nothing to rebuild.
  if (chatChunkCount === 0) return { needsRebuild: false, reasons: [] };

  const rebuiltAt = typeof rebuiltAtRaw === "string" ? rebuiltAtRaw : null;
  const rebuiltVersion =
    typeof rebuiltVersionRaw === "number" ? rebuiltVersionRaw : null;
  const defsChangedAt = typeof defsChangedRaw === "string" ? defsChangedRaw : null;

  const reasons: RebuildAdviceReason[] = [];

  // (a) Definitions changed since (or without) the last rebuild.
  const defsAfterRebuild =
    defsChangedAt !== null &&
    (rebuiltAt === null || new Date(defsChangedAt) > new Date(rebuiltAt));
  if (defsAfterRebuild) {
    reasons.push({
      code: "defs_changed",
      message:
        `Plugin or keyword definitions changed ${formatDistanceToNow(new Date(defsChangedAt), { addSuffix: true })}` +
        " — product tags on existing chat chunks may be stale.",
    });
  }

  // (b) Chunk-building rules moved on since the last RECORDED rebuild. A
  // null version means no rebuild was ever recorded — that is the fallback
  // reason below, not a rules change.
  if (rebuiltVersion !== null && rebuiltVersion < CHUNKER_VERSION) {
    reasons.push({
      code: "rules_updated",
      message:
        "Chunk-building rules changed in a recent update (e.g. noise filtering)" +
        " — existing chunks were built with older rules.",
    });
  }

  // Fallback: chunks exist but no completed full rebuild has ever been
  // recorded (also covers a half-written marker pair) and no specific reason
  // above fired.
  if (
    (rebuiltAt === null || rebuiltVersion === null) &&
    reasons.length === 0
  ) {
    reasons.push({
      code: "never_recorded",
      message: "No full rebuild has been recorded yet since this feature was added.",
    });
  }

  return { needsRebuild: reasons.length > 0, reasons };
}
