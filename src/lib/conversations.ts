import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { KNOWN_PRODUCTS } from "@/lib/rag/products";

/** Filterable, paginated conversation listing for the admin UI and API. */

export interface ConversationListFilters {
  page?: number;
  pageSize?: number;
  state?: string;
  tag?: string;
  product?: string;
  brandId?: string;
  email?: string;
  operatorId?: string;
  hasAttachment?: boolean;
  dateFrom?: Date;
  dateTo?: Date;
  search?: string;
}

export const conversationListItemSelect = {
  id: true,
  sessionId: true,
  state: true,
  visitorEmail: true,
  visitorNickname: true,
  visitorAvatar: true,
  country: true,
  city: true,
  tags: true,
  lastMessageAt: true,
  lastMessagePreview: true,
  updatedAtCrisp: true,
  createdAtCrisp: true,
  assignedOperator: { select: { crispUserId: true, name: true, avatar: true } },
  _count: { select: { messages: true, files: true } },
} satisfies Prisma.ConversationSelect;

export type ConversationListItem = Prisma.ConversationGetPayload<{
  select: typeof conversationListItemSelect;
}>;

export interface ConversationListResult {
  items: ConversationListItem[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

/** Full-text match on message bodies → conversation ids (max 500). */
async function fullTextConversationIds(query: string): Promise<string[]> {
  try {
    const rows = await prisma.$queryRaw<Array<{ conversationId: string }>>`
      SELECT DISTINCT "conversationId"
      FROM "Message"
      WHERE to_tsvector('simple', coalesce(content, ''))
            @@ websearch_to_tsquery('simple', ${query})
      LIMIT 500
    `;
    return rows.map((r) => r.conversationId);
  } catch {
    return [];
  }
}

export async function listConversations(
  filters: ConversationListFilters
): Promise<ConversationListResult> {
  const page = Math.max(1, filters.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, filters.pageSize ?? 25));

  const where: Prisma.ConversationWhereInput = {};
  const and: Prisma.ConversationWhereInput[] = [];

  if (filters.state) where.state = filters.state;
  if (filters.brandId) where.brandId = filters.brandId;
  if (filters.tag) where.tags = { has: filters.tag };
  if (filters.email) {
    where.visitorEmail = { contains: filters.email, mode: "insensitive" };
  }
  if (filters.operatorId) where.assignedOperatorId = filters.operatorId;
  if (filters.hasAttachment) where.files = { some: {} };
  if (filters.dateFrom || filters.dateTo) {
    where.lastMessageAt = {
      ...(filters.dateFrom ? { gte: filters.dateFrom } : {}),
      ...(filters.dateTo ? { lte: filters.dateTo } : {}),
    };
  }
  if (filters.product) {
    // Product lives on RAG chunks; tags may also name the product.
    and.push({
      OR: [
        { chunks: { some: { product: filters.product } } },
        { tags: { has: filters.product } },
      ],
    });
  }

  const search = filters.search?.trim();
  if (search) {
    const messageMatchIds = await fullTextConversationIds(search);
    and.push({
      OR: [
        { visitorEmail: { contains: search, mode: "insensitive" } },
        { visitorNickname: { contains: search, mode: "insensitive" } },
        { sessionId: { contains: search, mode: "insensitive" } },
        { lastMessagePreview: { contains: search, mode: "insensitive" } },
        ...(messageMatchIds.length > 0
          ? [{ id: { in: messageMatchIds } }]
          : [
              {
                messages: {
                  some: { content: { contains: search, mode: "insensitive" as const } },
                },
              },
            ]),
      ],
    });
  }
  if (and.length > 0) where.AND = and;

  const [total, items] = await prisma.$transaction([
    prisma.conversation.count({ where }),
    prisma.conversation.findMany({
      where,
      select: conversationListItemSelect,
      orderBy: [{ lastMessageAt: { sort: "desc", nulls: "last" } }, { id: "desc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);

  return {
    items,
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

export const conversationDetailInclude = {
  messages: { orderBy: { timestampCrisp: "asc" } },
  files: true,
  assignedOperator: true,
  chunks: {
    select: { id: true, chunkIndex: true, product: true, topic: true, language: true },
    orderBy: { chunkIndex: "asc" },
  },
} satisfies Prisma.ConversationInclude;

export type ConversationDetail = Prisma.ConversationGetPayload<{
  include: typeof conversationDetailInclude;
}>;

export async function getConversationDetail(
  sessionId: string
): Promise<ConversationDetail | null> {
  return prisma.conversation.findUnique({
    where: { sessionId },
    include: conversationDetailInclude,
  });
}

/** Distinct filter options for the conversations page. */
export async function getFilterOptions(): Promise<{
  states: string[];
  tags: string[];
  operators: Array<{ crispUserId: string; name: string | null }>;
  brands: Array<{ id: string; name: string }>;
  products: string[];
}> {
  const [states, tagRows, operators, brands, plugins] = await Promise.all([
    prisma.conversation.findMany({
      where: { state: { not: null } },
      select: { state: true },
      distinct: ["state"],
    }),
    prisma.$queryRaw<Array<{ tag: string }>>`
      SELECT DISTINCT unnest(tags) AS tag FROM "Conversation" ORDER BY tag LIMIT 200
    `,
    prisma.operator.findMany({
      select: { crispUserId: true, name: true },
      orderBy: { name: "asc" },
    }),
    prisma.brand.findMany({
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
    prisma.plugin.findMany({ select: { name: true }, orderBy: { name: "asc" } }),
  ]);
  return {
    states: states.map((s) => s.state!).filter(Boolean).sort(),
    tags: tagRows.map((t) => t.tag),
    operators,
    brands,
    // Product options come from managed plugins; fall back to the built-in
    // detector list on a fresh install.
    products:
      plugins.length > 0 ? plugins.map((p) => p.name) : [...KNOWN_PRODUCTS],
  };
}

/** Aggregate stats for the Crisp dashboard tab. */
export async function getDashboardStats() {
  const [
    totalConversations,
    totalMessages,
    totalChunks,
    resolvedCount,
    brandCount,
    lastSync,
    recentLogs,
  ] = await Promise.all([
    prisma.conversation.count(),
    prisma.message.count(),
    prisma.embeddingChunk.count(),
    prisma.conversation.count({ where: { state: "resolved" } }),
    prisma.brand.count(),
    prisma.syncLog.findFirst({
      where: { status: "completed" },
      orderBy: { finishedAt: "desc" },
    }),
    prisma.syncLog.findMany({ orderBy: { startedAt: "desc" }, take: 8 }),
  ]);
  return {
    totalConversations,
    totalMessages,
    totalChunks,
    resolvedCount,
    brandCount,
    lastSync,
    recentLogs,
  };
}
