import { PrismaClient } from "@prisma/client";

/**
 * Prisma client singleton. In dev, Next.js hot-reload re-evaluates modules,
 * so the instance is stashed on globalThis to avoid connection exhaustion.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: ["warn", "error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
