import { Tags } from "lucide-react";

import { HelpTip } from "@/components/help-tip";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { OrphanSegment } from "@/lib/rag/orphan-segments";

/**
 * "Orphan segments" — a compact read-only card on /rag listing Crisp segments
 * (Conversation.tags) that match no plugin definition, so the owner can see
 * which segments still need a plugin or a detection keyword. Server-rendered
 * from {@link getOrphanSegments}; the /rag page is force-dynamic so it reflects
 * the current tags and plugin keywords on every load.
 */
export function OrphanSegmentsCard({
  segments,
}: {
  segments: OrphanSegment[];
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Tags className="text-muted-foreground size-4" />
          Orphan segments
          <HelpTip subject="orphan segments">
            Crisp segments (conversation tags) that match no plugin name or
            detection keyword. Chunks tagged only with these fall through
            product detection, so they get no plugin and stay out of
            plugin/brand-scoped retrieval. Add a plugin or a detection keyword
            in <span className="font-medium">/plugins</span>, then rebuild
            chunks, to fix a segment.
          </HelpTip>
        </CardTitle>
        <CardDescription>
          Segments with no matching plugin — top{" "}
          {Math.min(segments.length, 20)} by conversation count.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {segments.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            Every segment in use maps to a plugin. Nothing to add.
          </p>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {segments.map((segment) => (
              <li key={segment.tag}>
                <Badge
                  variant="outline"
                  className="gap-1.5 font-normal"
                  title={`${segment.count} conversation${segment.count === 1 ? "" : "s"}`}
                >
                  <span className="truncate">{segment.tag}</span>
                  <span className="text-muted-foreground tabular-nums">
                    {segment.count}
                  </span>
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
