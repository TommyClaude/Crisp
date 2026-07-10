import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { invalidateProductDefinitions } from "@/lib/rag/product-defs";

export const dynamic = "force-dynamic";

const patchSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  wpOrgSlug: z.string().max(200).nullable().optional(),
  detectionKeywords: z.array(z.string().min(1).max(100)).max(50).optional(),
});

/** PATCH /api/plugins/:id — update name/keywords/wp.org slug. */
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
    const plugin = await prisma.plugin.update({
      where: { id },
      data: {
        ...(parsed.data.name !== undefined
          ? { name: parsed.data.name.trim() }
          : {}),
        ...(parsed.data.wpOrgSlug !== undefined
          ? { wpOrgSlug: parsed.data.wpOrgSlug?.trim() || null }
          : {}),
        ...(parsed.data.detectionKeywords !== undefined
          ? { detectionKeywords: parsed.data.detectionKeywords }
          : {}),
      },
    });
    invalidateProductDefinitions();
    return NextResponse.json({ plugin });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === "P2025") {
        return NextResponse.json({ error: "Plugin not found" }, { status: 404 });
      }
      if (error.code === "P2002") {
        return NextResponse.json(
          { error: "A plugin with this name already exists" },
          { status: 409 }
        );
      }
    }
    throw error;
  }
}

/** DELETE /api/plugins/:id — removes the plugin, its docs and doc chunks. */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    await prisma.plugin.delete({ where: { id } });
    invalidateProductDefinitions();
    return NextResponse.json({ deleted: true });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2025"
    ) {
      return NextResponse.json({ error: "Plugin not found" }, { status: 404 });
    }
    throw error;
  }
}
