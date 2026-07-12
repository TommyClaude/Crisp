import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

const patchSchema = z.object({
  status: z.enum(["new", "drafted", "reviewed", "dismissed"]),
});

/** PATCH /api/wporg/threads/:id — update review status. */
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
    const thread = await prisma.supportThread.update({
      where: { id },
      // A status change (reviewed/dismissed/…) means the admin has acted on the
      // topic — clear the "New reply" flag and any pending follow-up promise so
      // neither badge lingers.
      data: {
        status: parsed.data.status,
        hasNewReply: false,
        followupPromisedAt: null,
        // Reviewing/dismissing ends the "waiting on the customer" state too, so
        // the topic drops out of "Needs resolved"; the watcher restarts the
        // clock if the team replies again later.
        waitingSince: null,
      },
    });
    return NextResponse.json({ thread });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2025"
    ) {
      return NextResponse.json({ error: "Topic not found" }, { status: 404 });
    }
    throw error;
  }
}

/** DELETE /api/wporg/threads/:id — remove a thread entirely. */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    await prisma.supportThread.delete({ where: { id } });
    return NextResponse.json({ deleted: true });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2025"
    ) {
      return NextResponse.json({ error: "Topic not found" }, { status: 404 });
    }
    throw error;
  }
}
