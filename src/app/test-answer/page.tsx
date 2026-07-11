import type { Metadata } from "next";

import { TestAnswerForm } from "@/components/test-answer/test-answer-form";
import { prisma } from "@/lib/db";

export const metadata: Metadata = {
  title: "Test Answer",
};

export const dynamic = "force-dynamic";

export default async function TestAnswerPage() {
  const plugins = await prisma.plugin.findMany({
    select: { id: true, name: true, brand: { select: { name: true } } },
    orderBy: { name: "asc" },
  });

  const items = plugins.map((plugin) => ({
    id: plugin.id,
    name: plugin.name,
    brandName: plugin.brand.name,
  }));

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6 lg:p-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Test Answer</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Paste a hypothetical support question to preview the reply drafts it
          would get from the current knowledge base — nothing is saved.
        </p>
      </header>

      <TestAnswerForm plugins={items} />
    </div>
  );
}
