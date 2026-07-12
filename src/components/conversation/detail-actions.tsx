"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  ExternalLink,
  LoaderCircle,
  RefreshCw,
  Sparkles,
  Trash2,
  Undo2,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

async function readErrorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body?.error === "string" && body.error) return body.error;
  } catch {
    // Non-JSON error body — fall through to the generic message.
  }
  return `Request failed (${res.status})`;
}

/**
 * Header action bar: open in Crisp, resync from Crisp, rebuild RAG chunks, and
 * the manual junk veto (mark/unmark). Marking junk deletes the conversation's
 * RAG chunks and — like every manual mark — pins the decision so no future sync
 * or scan overwrites it (junkOverride).
 */
export function DetailActions({
  sessionId,
  websiteId,
  isJunk,
}: {
  sessionId: string;
  websiteId: string;
  isJunk: boolean;
}) {
  const router = useRouter();
  const [resyncing, setResyncing] = React.useState(false);
  const [rebuilding, setRebuilding] = React.useState(false);
  const [markingJunk, setMarkingJunk] = React.useState(false);
  const busy = resyncing || rebuilding || markingJunk;

  const crispUrl = `https://app.crisp.chat/website/${websiteId}/inbox/${sessionId}/`;

  const toggleJunk = async () => {
    const nextJunk = !isJunk;
    setMarkingJunk(true);
    try {
      const res = await fetch(
        `/api/conversations/${encodeURIComponent(sessionId)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ junk: nextJunk }),
        }
      );
      if (!res.ok) {
        toast.error("Failed to update junk status", {
          description: await readErrorMessage(res),
        });
        return;
      }
      const data = (await res.json()) as { cleaned?: number };
      if (nextJunk) {
        toast.success("Marked as junk", {
          description:
            (data.cleaned ?? 0) > 0
              ? `Removed from the AI's knowledge (${data.cleaned} ${
                  data.cleaned === 1 ? "chunk" : "chunks"
                } deleted). A re-scan won't change this back.`
              : "Kept out of the AI's knowledge. A re-scan won't change this back.",
        });
      } else {
        toast.success("Unmarked as junk", {
          description: "It can be chunked again on the next rebuild or sync.",
        });
      }
      router.refresh();
    } catch {
      toast.error("Failed to update junk status", {
        description: "Network error",
      });
    } finally {
      setMarkingJunk(false);
    }
  };

  const resync = async () => {
    setResyncing(true);
    try {
      const res = await fetch(
        `/api/sync/crisp/conversation/${encodeURIComponent(sessionId)}`,
        { method: "POST" }
      );
      if (!res.ok) {
        toast.error("Resync failed", {
          description: await readErrorMessage(res),
        });
        return;
      }
      const data = (await res.json()) as {
        messageCount?: number;
        chunksCreated?: number;
      };
      toast.success("Conversation resynced", {
        description: `${data.messageCount ?? 0} messages · ${
          data.chunksCreated ?? 0
        } chunks`,
      });
      router.refresh();
    } catch {
      toast.error("Resync failed", { description: "Network error" });
    } finally {
      setResyncing(false);
    }
  };

  const rebuildChunks = async () => {
    setRebuilding(true);
    try {
      const res = await fetch("/api/rag/chunks/rebuild", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId }),
      });
      if (!res.ok) {
        toast.error("Chunk rebuild failed", {
          description: await readErrorMessage(res),
        });
        return;
      }
      const data = (await res.json()) as { chunksCreated?: number };
      toast.success("Chunks rebuilt", {
        description: `${data.chunksCreated ?? 0} ${
          (data.chunksCreated ?? 0) === 1 ? "chunk" : "chunks"
        } created`,
      });
      router.refresh();
    } catch {
      toast.error("Chunk rebuild failed", { description: "Network error" });
    } finally {
      setRebuilding(false);
    }
  };

  return (
    <div className="flex shrink-0 items-center gap-2">
      <Button variant="outline" size="sm" asChild>
        <a href={crispUrl} target="_blank" rel="noreferrer">
          <ExternalLink className="size-3.5" />
          <span className="max-sm:hidden">Open in Crisp</span>
        </a>
      </Button>
      <Button variant="outline" size="sm" onClick={resync} disabled={busy}>
        <RefreshCw className={cn("size-3.5", resyncing && "animate-spin")} />
        <span className="max-sm:hidden">Resync</span>
      </Button>
      <Button
        variant="outline"
        size="sm"
        onClick={rebuildChunks}
        disabled={busy}
      >
        {rebuilding ? (
          <LoaderCircle className="size-3.5 animate-spin" />
        ) : (
          <Sparkles className="size-3.5" />
        )}
        <span className="max-sm:hidden">Rebuild chunks</span>
      </Button>
      {isJunk ? (
        <Button
          variant="outline"
          size="sm"
          onClick={toggleJunk}
          disabled={busy}
        >
          {markingJunk ? (
            <LoaderCircle className="size-3.5 animate-spin" />
          ) : (
            <Undo2 className="size-3.5" />
          )}
          <span className="max-sm:hidden">Not junk</span>
        </Button>
      ) : (
        <Button
          variant="outline"
          size="sm"
          onClick={toggleJunk}
          disabled={busy}
          className="border-red-200 text-red-600 hover:bg-red-50 hover:text-red-700 dark:border-red-500/30 dark:text-red-400 dark:hover:bg-red-500/10"
        >
          {markingJunk ? (
            <LoaderCircle className="size-3.5 animate-spin" />
          ) : (
            <Trash2 className="size-3.5" />
          )}
          <span className="max-sm:hidden">Mark as junk</span>
        </Button>
      )}
    </div>
  );
}
