import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * GET /api/health — unauthenticated liveness/readiness probe.
 *
 * Deliberately excluded from Basic Auth in src/middleware.ts so Docker
 * healthchecks, the Caddy reverse proxy, and external uptime monitors can hit
 * it without credentials. Runs a cheap `SELECT 1` to confirm Postgres is
 * actually reachable (not just that the Node process is up) — returns 503
 * when it isn't, which is what marks the `app` container unhealthy in
 * docker-compose.yml.
 */
export async function GET() {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return NextResponse.json({ ok: true, db: true });
  } catch (error) {
    console.error("[health] database check failed:", error);
    return NextResponse.json({ ok: false, db: false }, { status: 503 });
  }
}
