import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

const patchSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  crispWebsiteId: z.string().min(8).max(100).optional(),
  domain: z.string().max(200).nullable().optional(),
});

/** PATCH /api/brands/:id — update name/websiteId/domain. */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = patchSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request", issues: parsed.error.issues },
      { status: 400 }
    );
  }

  try {
    const brand = await prisma.brand.update({
      where: { id },
      data: {
        ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
        ...(parsed.data.crispWebsiteId !== undefined
          ? { crispWebsiteId: parsed.data.crispWebsiteId.trim() }
          : {}),
        ...(parsed.data.domain !== undefined
          ? { domain: parsed.data.domain?.trim() || null }
          : {}),
      },
    });
    return NextResponse.json({ brand });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === "P2025") {
        return NextResponse.json({ error: "Brand not found" }, { status: 404 });
      }
      if (error.code === "P2002") {
        return NextResponse.json(
          { error: "Another brand already uses this Crisp website ID" },
          { status: 409 }
        );
      }
    }
    throw error;
  }
}

/**
 * DELETE /api/brands/:id — removes the brand and its plugins/docs (cascade).
 * Conversations are kept (brandId becomes null).
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    await prisma.brand.delete({ where: { id } });
    return NextResponse.json({ deleted: true });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2025"
    ) {
      return NextResponse.json({ error: "Brand not found" }, { status: 404 });
    }
    throw error;
  }
}
