import type { Metadata } from "next";

import { RagSearch } from "@/components/rag/rag-search";

export const metadata: Metadata = {
  title: "RAG Search",
};

export default function RagPage() {
  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6 lg:p-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">RAG Search</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Test retrieval over archived conversations
        </p>
      </header>

      <RagSearch />
    </div>
  );
}
