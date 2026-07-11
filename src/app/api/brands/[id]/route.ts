import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { encryptSecret } from "@/lib/crypto";

export const dynamic = "force-dynamic";

const patchSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  crispWebsiteId: z.string().min(8).max(100).optional(),
  domain: z.string().max(200).nullable().optional(),
  // Token update: send both to set, or crispKey:"" (with identifier:"") to clear.
  crispIdentifier: z.string().max(200).nullable().optional(),
  crispKey: z.string().max(500).nullable().optional(),
  // wordpress.org author username: send to set, "" or null to clear.
  wpProfileSlug: z.string().max(100).nullable().optional(),
});

/** PATCH /api/brands/:id — update name/websiteId/domain/token. */
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

  // Token fields move together: set both, or clear both.
  const tokenData: Prisma.BrandUpdateInput = {};
  if (
    parsed.data.crispIdentifier !== undefined ||
    parsed.data.crispKey !== undefined
  ) {
    const identifier = parsed.data.crispIdentifier?.trim() || null;
    const key = parsed.data.crispKey?.trim() || null;
    if ((identifier && !key) || (!identifier && key)) {
      return NextResponse.json(
        { error: "Provide both the Crisp identifier and key, or clear both" },
        { status: 400 }
      );
    }
    tokenData.crispIdentifier = identifier;
    tokenData.crispKeyEnc = key ? encryptSecret(key) : null;
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
        ...(parsed.data.wpProfileSlug !== undefined
          ? { wpProfileSlug: parsed.data.wpProfileSlug?.trim() || null }
          : {}),
        ...tokenData,
      },
    });
    const { crispKeyEnc, ...safe } = brand;
    return NextResponse.json({
      brand: { ...safe, hasCrispKey: Boolean(crispKeyEnc) },
    });
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
