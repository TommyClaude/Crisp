"use client";

import * as React from "react";
import Link from "next/link";
import {
  ArrowUpRight,
  BookOpen,
  Check,
  Copy,
  LifeBuoy,
  MessagesSquare,
  Sparkles,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Shared presentational pieces for reply drafts + grounding context, used by
 * both the /suggestions thread cards and the /test-answer playground so the
 * two never drift. Purely presentational — no data fetching.
 */

export const PROVIDER_LABELS: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
};

/** One provider's draft for the UI (provider null = legacy single draft). */
export interface DraftItemView {
  provider: "anthropic" | "openai" | null;
  model: string | null;
  text: string | null;
  error: string | null;
}

export interface ContextChunkItem {
  source: "crisp_chat" | "plugin_docs" | "wporg_forum";
  similarity: number | null;
  title: string;
  link: string | null;
  excerpt: string;
  product: string | null;
}

/** Violet per-provider draft cards with a per-card Copy button. */
export function DraftCards({ drafts }: { drafts: DraftItemView[] }) {
  const [copiedKey, setCopiedKey] = React.useState<string | null>(null);
  const draftsWithText = drafts.filter((draft) => draft.text);
  if (draftsWithText.length === 0) return null;

  const copyDraft = async (key: string, text: string) => {
    await navigator.clipboard.writeText(text);
    setCopiedKey(key);
    toast.success("Draft copied to clipboard");
    setTimeout(() => setCopiedKey((k) => (k === key ? null : k)), 2000);
  };

  return (
    <div
      className={cn(
        "grid gap-3",
        draftsWithText.length > 1 ? "md:grid-cols-2" : "grid-cols-1"
      )}
    >
      {drafts.map((draft, index) => {
        if (!draft.text) return null;
        const key = `${draft.provider ?? "draft"}-${index}`;
        const label = draft.provider
          ? PROVIDER_LABELS[draft.provider] ?? draft.provider
          : "Suggested reply";
        return (
          <div
            key={key}
            className="flex flex-col rounded-md border border-violet-200 bg-violet-50/50 p-3 dark:border-violet-500/25 dark:bg-violet-500/5"
          >
            <div className="mb-1.5 flex items-center gap-2">
              <Sparkles className="size-3.5 shrink-0 text-violet-600 dark:text-violet-400" />
              <span className="text-xs font-medium text-violet-700 dark:text-violet-400">
                {label}
              </span>
              {draft.model ? (
                <span className="text-muted-foreground truncate font-mono text-[11px]">
                  {draft.model}
                </span>
              ) : null}
              <Button
                variant="ghost"
                size="sm"
                className="ml-auto h-6 shrink-0 px-2 text-xs"
                onClick={() => copyDraft(key, draft.text!)}
              >
                {copiedKey === key ? (
                  <Check className="size-3" />
                ) : (
                  <Copy className="size-3" />
                )}
                Copy
              </Button>
            </div>
            <p className="text-sm whitespace-pre-wrap">{draft.text}</p>
          </div>
        );
      })}
    </div>
  );
}

/** Per-provider failure lines (renders nothing when no draft errored). */
export function DraftErrorLines({ drafts }: { drafts: DraftItemView[] }) {
  const errored = drafts.filter((draft) => !draft.text && draft.error);
  if (errored.length === 0) return null;
  return (
    <div className="space-y-0.5">
      {errored.map((draft, index) => (
        <p
          key={`err-${draft.provider ?? index}`}
          className="text-destructive text-xs"
        >
          {draft.provider
            ? PROVIDER_LABELS[draft.provider] ?? draft.provider
            : "Draft"}{" "}
          failed: {draft.error}
        </p>
      ))}
    </div>
  );
}

/** The grounding-context list (renders nothing when there are no chunks). */
export function ContextChunkList({ chunks }: { chunks: ContextChunkItem[] }) {
  if (chunks.length === 0) return null;
  return (
    <div className="space-y-1">
      <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
        Grounding context
      </p>
      {chunks.map((chunk, index) => (
        <div
          key={index}
          className="flex flex-wrap items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs"
        >
          {chunk.source === "plugin_docs" ? (
            <BookOpen className="text-muted-foreground size-3.5 shrink-0" />
          ) : chunk.source === "wporg_forum" ? (
            <LifeBuoy className="text-muted-foreground size-3.5 shrink-0" />
          ) : (
            <MessagesSquare className="text-muted-foreground size-3.5 shrink-0" />
          )}
          {chunk.link ? (
            chunk.link.startsWith("/") ? (
              <Link
                href={chunk.link}
                className="group inline-flex min-w-0 items-center gap-1 truncate font-medium hover:text-blue-600 dark:hover:text-blue-400"
              >
                <span className="truncate">{chunk.title}</span>
                <ArrowUpRight className="size-3 opacity-0 group-hover:opacity-100" />
              </Link>
            ) : (
              <a
                href={chunk.link}
                target="_blank"
                rel="noreferrer"
                className="group inline-flex min-w-0 items-center gap-1 truncate font-medium hover:text-blue-600 dark:hover:text-blue-400"
              >
                <span className="truncate">{chunk.title}</span>
                <ArrowUpRight className="size-3 opacity-0 group-hover:opacity-100" />
              </a>
            )
          ) : (
            <span className="truncate font-medium">{chunk.title}</span>
          )}
          {chunk.product ? (
            <Badge variant="outline" className="px-1.5 py-0 text-[11px]">
              {chunk.product}
            </Badge>
          ) : null}
          {chunk.similarity != null ? (
            <span className="text-muted-foreground ml-auto tabular-nums">
              {Math.round(Math.max(0, Math.min(1, chunk.similarity)) * 100)}%
            </span>
          ) : null}
        </div>
      ))}
    </div>
  );
}
