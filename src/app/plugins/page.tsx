import { prisma } from "@/lib/db";
import { PluginManager } from "@/components/plugins/plugin-manager";

export const dynamic = "force-dynamic";

export default async function PluginsPage() {
  const [brands, plugins] = await Promise.all([
    prisma.brand.findMany({
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
    prisma.plugin.findMany({
      orderBy: [{ brand: { name: "asc" } }, { name: "asc" }],
      include: {
        brand: { select: { id: true, name: true } },
        docsSources: { orderBy: { createdAt: "asc" } },
        _count: { select: { chunks: true } },
      },
    }),
  ]);

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Plugins &amp; Docs
        </h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Plugins drive product detection on chat chunks; each plugin can have
          documentation sources that are crawled into the RAG index.
        </p>
      </div>
      <PluginManager
        brands={brands}
        plugins={plugins.map((plugin) => ({
          id: plugin.id,
          name: plugin.name,
          wpOrgSlug: plugin.wpOrgSlug,
          detectionKeywords: plugin.detectionKeywords,
          brand: plugin.brand,
          chunkCount: plugin._count.chunks,
          docsSources: plugin.docsSources.map((source) => ({
            id: source.id,
            url: source.url,
            type: source.type,
            status: source.status,
            pageCount: source.pageCount,
            chunkCount: source.chunkCount,
            lastCrawledAt: source.lastCrawledAt?.toISOString() ?? null,
            error: source.error,
          })),
        }))}
      />
    </div>
  );
}
