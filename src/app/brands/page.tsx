import { prisma } from "@/lib/db";
import { BrandManager } from "@/components/brands/brand-manager";

export const dynamic = "force-dynamic";

export default async function BrandsPage() {
  const brands = await prisma.brand.findMany({
    orderBy: { createdAt: "asc" },
    include: { _count: { select: { plugins: true, conversations: true } } },
  });

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Brands</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          One brand per Crisp website — the sync pulls conversations from every
          brand listed here.
        </p>
      </div>
      <BrandManager
        brands={brands.map((brand) => ({
          id: brand.id,
          name: brand.name,
          crispWebsiteId: brand.crispWebsiteId,
          wpProfileSlug: brand.wpProfileSlug,
          replyStyle: brand.replyStyle,
          pluginCount: brand._count.plugins,
          conversationCount: brand._count.conversations,
        }))}
      />
    </div>
  );
}
