"use client";

import * as React from "react";
import { FlaskConical, LoaderCircle, RotateCcw, Sparkles } from "lucide-react";
import { toast } from "sonner";

import {
  ContextChunkList,
  DraftCards,
  DraftErrorLines,
  type ContextChunkItem,
  type DraftItemView,
} from "@/components/suggestions/draft-parts";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

export interface TestAnswerPlugin {
  id: string;
  name: string;
  brandName: string;
}

/** Mirrors the JSON returned by POST /api/suggest/test. */
interface TestAnswerResult {
  drafts: DraftItemView[];
  contextChunks: ContextChunkItem[];
  status: string;
  suggestError: string | null;
  llmConfigured: boolean;
}

const MIN_CONTENT = 10;

export function TestAnswerForm({ plugins }: { plugins: TestAnswerPlugin[] }) {
  const [pluginId, setPluginId] = React.useState(plugins[0]?.id ?? "");
  const [title, setTitle] = React.useState("");
  const [content, setContent] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const [result, setResult] = React.useState<TestAnswerResult | null>(null);

  if (plugins.length === 0) {
    return (
      <div className="text-muted-foreground rounded-lg border border-dashed p-10 text-center text-sm">
        <FlaskConical className="mx-auto mb-2 size-6 opacity-60" />
        Add a plugin in{" "}
        <span className="text-foreground font-medium">Plugins &amp; Docs</span>{" "}
        first — drafts are grounded in a plugin&apos;s knowledge base.
      </div>
    );
  }

  const canSubmit =
    pluginId.length > 0 && content.trim().length >= MIN_CONTENT && !loading;

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmit) return;

    setLoading(true);
    try {
      const res = await fetch("/api/suggest/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pluginId,
          title: title.trim() || undefined,
          content: content.trim(),
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(body.error ?? "Failed to generate suggestions");
        return;
      }
      setResult(body as TestAnswerResult);
    } catch {
      toast.error("Failed to generate suggestions");
    } finally {
      setLoading(false);
    }
  };

  const handleClear = () => {
    setResult(null);
    setTitle("");
    setContent("");
  };

  const draftsWithText = result?.drafts.filter((draft) => draft.text) ?? [];

  return (
    <div className="space-y-6">
      <Card className="gap-4 py-5">
        <CardContent className="px-5">
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid gap-2">
              <Label htmlFor="ta-plugin">Plugin</Label>
              <Select value={pluginId} onValueChange={setPluginId}>
                <SelectTrigger
                  id="ta-plugin"
                  className="w-full sm:max-w-lg"
                  // Hover fallback for names that still overflow the trigger.
                  title={plugins.find((p) => p.id === pluginId)?.name}
                >
                  <SelectValue placeholder="Select a plugin" />
                </SelectTrigger>
                <SelectContent>
                  {plugins.map((plugin) => (
                    <SelectItem key={plugin.id} value={plugin.id}>
                      {plugin.name}
                      <span className="text-muted-foreground ml-1.5 text-xs">
                        {plugin.brandName}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="grid gap-2">
              <Label htmlFor="ta-title">
                Title{" "}
                <span className="text-muted-foreground font-normal">
                  (optional)
                </span>
              </Label>
              <Input
                id="ta-title"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="Folders disappeared after update"
                disabled={loading}
              />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="ta-content">Question</Label>
              <Textarea
                id="ta-content"
                value={content}
                onChange={(event) => setContent(event.target.value)}
                rows={8}
                placeholder={
                  "Hi,\n\nAfter updating to the latest version all my media folders are gone and everything is back in the root. I didn't change anything else. How do I get them back?\n\nThanks!"
                }
                disabled={loading}
              />
            </div>

            <div className="flex items-center gap-2">
              <Button type="submit" disabled={!canSubmit}>
                {loading ? (
                  <LoaderCircle className="size-4 animate-spin" />
                ) : (
                  <Sparkles className="size-4" />
                )}
                {loading ? "Generating…" : "Generate drafts"}
              </Button>
              {result ? (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={handleClear}
                  disabled={loading}
                >
                  <RotateCcw className="size-4" />
                  Clear
                </Button>
              ) : null}
            </div>
          </form>
        </CardContent>
      </Card>

      {result ? (
        <section aria-label="Draft results" className="space-y-3">
          {draftsWithText.length > 0 ? (
            <>
              <DraftCards drafts={result.drafts} />
              <DraftErrorLines drafts={result.drafts} />
            </>
          ) : result.suggestError ? (
            <p className="text-destructive text-xs">
              Draft failed: {result.suggestError}
            </p>
          ) : (
            <p className="text-muted-foreground text-xs">
              {result.llmConfigured
                ? "No drafts were produced — try rephrasing the question or check that your AI provider is reachable."
                : "No LLM provider configured — use the retrieved context below to compose a reply (set ANTHROPIC_API_KEY or OPENAI_API_KEY to enable drafts)."}
            </p>
          )}

          <ContextChunkList chunks={result.contextChunks} />

          {draftsWithText.length === 0 &&
          result.contextChunks.length === 0 &&
          !result.suggestError ? (
            <div className="text-muted-foreground rounded-lg border border-dashed p-8 text-center text-xs">
              No grounding context found for this question yet — sync
              conversations, crawl docs, or ingest the forum for this plugin.
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
