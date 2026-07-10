import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  status: z
    .enum(["new", "drafted", "failed", "reviewed", "dismissed"])
    .optional(),
  pluginId: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

/** GET /api/wporg/threads — support threads with their suggestions. */
export async function GET(request: NextRequest) {
  const params = Object.fromEntries(request.nextUrl.searchParams.entries());
  const parsed = querySchema.safeParse(params);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid query parameters", issues: parsed.error.issues },
      { status: 400 }
    );
  }
  const { status, pluginId, page, pageSize } = parsed.data;
  const where = {
    ...(status ? { status } : {}),
    ...(pluginId ? { pluginId } : {}),
  };

  const [total, threads] = await prisma.$transaction([
    prisma.supportThread.count({ where }),
    prisma.supportThread.findMany({
      where,
      include: { plugin: { select: { id: true, name: true, wpOrgSlug: true } } },
      orderBy: [{ publishedAt: { sort: "desc", nulls: "last" } }, { fetchedAt: "desc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);

  return NextResponse.json({
    threads,
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  });
}
