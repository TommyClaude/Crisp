"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ExternalLink, LoaderCircle, RefreshCw, Sparkles } from "lucide-react";
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

/** Header action bar: open in Crisp, resync from Crisp, rebuild RAG chunks. */
export function DetailActions({
  sessionId,
  websiteId,
}: {
  sessionId: string;
  websiteId: string;
}) {
  const router = useRouter();
  const [resyncing, setResyncing] = React.useState(false);
  const [rebuilding, setRebuilding] = React.useState(false);
  const busy = resyncing || rebuilding;

  const crispUrl = `https://app.crisp.chat/website/${websiteId}/inbox/${sessionId}/`;

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
    </div>
  );
}
