import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

/** GET /api/docs/sources/:id — source status (used for ingest polling). */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const source = await prisma.docsSource.findUnique({ where: { id } });
  if (!source) {
    return NextResponse.json({ error: "Docs source not found" }, { status: 404 });
  }
  return NextResponse.json({ source });
}

/** DELETE /api/docs/sources/:id — removes the source, its pages and chunks. */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    await prisma.docsSource.delete({ where: { id } });
    return NextResponse.json({ deleted: true });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2025"
    ) {
      return NextResponse.json(
        { error: "Docs source not found" },
        { status: 404 }
      );
    }
    throw error;
  }
}
