import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { listConversations } from "@/lib/conversations";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  state: z.string().optional(),
  tag: z.string().optional(),
  product: z.string().optional(),
  brandId: z.string().optional(),
  email: z.string().optional(),
  operatorId: z.string().optional(),
  hasAttachment: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v === "true"),
  dateFrom: z.coerce.date().optional(),
  dateTo: z.coerce.date().optional(),
  search: z.string().max(500).optional(),
  preview: z.string().max(500).optional(),
  junk: z.enum(["hide", "only"]).optional(),
});

/**
 * GET /api/conversations
 * Paginated conversation list with filters and search.
 * Query params: page, pageSize, state, tag, product, email, operatorId,
 * hasAttachment, dateFrom, dateTo, search, preview, junk.
 */
export async function GET(request: NextRequest) {
  const params = Object.fromEntries(request.nextUrl.searchParams.entries());
  const parsed = querySchema.safeParse(params);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid query parameters", issues: parsed.error.issues },
      { status: 400 }
    );
  }

  try {
    const result = await listConversations(parsed.data);
    return NextResponse.json(result);
  } catch (error) {
    console.error("Conversation list failed:", error);
    return NextResponse.json(
      { error: "Failed to list conversations" },
      { status: 500 }
    );
  }
}
