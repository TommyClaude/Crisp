import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { ingestDocsSource, isIngestRunning } from "@/lib/docs/ingest";

export const dynamic = "force-dynamic";

/**
 * POST /api/docs/sources/:id/ingest
 * Kicks off a background crawl+chunk+embed for the docs source and returns
 * 202. Progress is reflected on the DocsSource row (status/pageCount/error),
 * which the /plugins UI polls.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const source = await prisma.docsSource.findUnique({
    where: { id },
    select: { id: true, status: true },
  });
  if (!source) {
    return NextResponse.json({ error: "Docs source not found" }, { status: 404 });
  }
  if (isIngestRunning(id) || source.status === "crawling") {
    return NextResponse.json(
      { error: "An ingest is already running for this source" },
      { status: 409 }
    );
  }

  ingestDocsSource(id)
    .then((result) =>
      console.log(
        `Docs ingest finished for ${id}: ${result.pages} pages (${result.pagesChanged} changed), ${result.chunks} chunks`
      )
    )
    .catch((error) => console.error(`Docs ingest failed for ${id}:`, error));

  return NextResponse.json({ started: true }, { status: 202 });
}
