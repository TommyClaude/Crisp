import type { Metadata } from "next";

import { OrphanSegmentsCard } from "@/components/rag/orphan-segments";
import { RagSearch } from "@/components/rag/rag-search";
import { getOrphanSegments } from "@/lib/rag/orphan-segments";
import { getRebuildAdvice } from "@/lib/rag/rebuild-advice";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "RAG Search",
};

export default async function RagPage() {
  // Server-render the initial advice so the "rebuild recommended" banner (and
  // its absence) never flashes on the client before the mount fetch resolves.
  const [initialAdvice, orphanSegments] = await Promise.all([
    getRebuildAdvice(),
    getOrphanSegments(),
  ]);

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6 lg:p-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">RAG Search</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Test retrieval over archived conversations
        </p>
      </header>

      <RagSearch initialAdvice={initialAdvice} />

      <OrphanSegmentsCard segments={orphanSegments} />
    </div>
  );
}
