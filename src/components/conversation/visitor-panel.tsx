import { format } from "date-fns";
import { Layers, MapPin, Paperclip } from "lucide-react";

import { SensitiveValue } from "@/components/sensitive-value";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

/** Plain (JSON-serializable) data shown in the right-hand visitor panel. */
export interface VisitorPanelData {
  sessionId: string;
  state: string | null;
  visitorEmail: string | null;
  visitorNickname: string | null;
  visitorAvatar: string | null;
  visitorPhone: string | null;
  visitorUserId: string | null;
  country: string | null;
  city: string | null;
  ip: string | null;
  tags: string[];
  createdAtCrisp: string | null; // ISO string
  lastMessageAt: string | null; // ISO string
  messageCount: number;
  fileCount: number;
  assignedOperator: {
    crispUserId: string;
    name: string | null;
    avatar: string | null;
  } | null;
  chunkCount: number;
  chunkProducts: string[];
}

const STATE_STYLES: Record<string, string> = {
  resolved:
    "border-transparent bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400",
  unresolved:
    "border-transparent bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-400",
  pending:
    "border-transparent bg-zinc-100 text-zinc-600 dark:bg-zinc-500/15 dark:text-zinc-400",
};

/** Colored conversation-state badge (resolved / unresolved / pending). */
export function StateBadge({
  state,
  className,
}: {
  state: string | null;
  className?: string;
}) {
  if (!state) return null;
  return (
    <Badge
      className={cn(
        "capitalize",
        STATE_STYLES[state] ?? STATE_STYLES.pending,
        className
      )}
    >
      {state}
    </Badge>
  );
}

function initials(nickname: string | null, email: string | null): string {
  const source = nickname?.trim() || email?.trim();
  if (!source) return "?";
  const parts = source.split(/[\s@._-]+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0].charAt(0) + parts[1].charAt(0)).toUpperCase();
  }
  return source.slice(0, 2).toUpperCase();
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-muted-foreground text-xs font-medium tracking-wider uppercase">
      {children}
    </h3>
  );
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <span className="text-muted-foreground shrink-0 text-xs leading-5">
        {label}
      </span>
      <span className="min-w-0 text-right text-xs leading-5">{children}</span>
    </div>
  );
}

const EMPTY = <span className="text-muted-foreground">—</span>;

function formatDate(iso: string | null): React.ReactNode {
  if (!iso) return EMPTY;
  return format(new Date(iso), "MMM d, yyyy HH:mm");
}

/** Right-hand sidebar with visitor identity, contact, location and metadata. */
export function VisitorPanel({ data }: { data: VisitorPanelData }) {
  const name = data.visitorNickname || data.visitorEmail || "Anonymous";
  const location =
    [data.city, data.country].filter(Boolean).join(", ") || null;

  return (
    <div className="space-y-5 p-5">
      {/* Identity */}
      <div className="flex items-center gap-3">
        <Avatar className="size-12">
          {data.visitorAvatar ? (
            <AvatarImage src={data.visitorAvatar} alt="" />
          ) : null}
          <AvatarFallback className="text-sm font-medium">
            {initials(data.visitorNickname, data.visitorEmail)}
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{name}</p>
          <div className="mt-1">
            <StateBadge state={data.state} />
          </div>
        </div>
      </div>

      <Separator />

      {/* Contact */}
      <section className="space-y-2">
        <SectionLabel>Contact</SectionLabel>
        <Row label="Email">
          {data.visitorEmail ? (
            <SensitiveValue value={data.visitorEmail} kind="email" />
          ) : (
            EMPTY
          )}
        </Row>
        <Row label="Phone">
          {data.visitorPhone ? (
            <SensitiveValue value={data.visitorPhone} kind="phone" />
          ) : (
            EMPTY
          )}
        </Row>
      </section>

      <Separator />

      {/* Location */}
      <section className="space-y-2">
        <SectionLabel>Location</SectionLabel>
        <div className="flex items-center gap-1.5 text-xs">
          <MapPin className="text-muted-foreground size-3.5 shrink-0" aria-hidden />
          {location ? (
            <span className="truncate">{location}</span>
          ) : (
            EMPTY
          )}
        </div>
        <Row label="IP address">
          {data.ip ? <SensitiveValue value={data.ip} kind="ip" /> : EMPTY}
        </Row>
      </section>

      <Separator />

      {/* Details */}
      <section className="space-y-2">
        <SectionLabel>Details</SectionLabel>
        <Row label="User ID">
          {data.visitorUserId ? (
            <span
              className="block max-w-40 truncate font-mono"
              title={data.visitorUserId}
            >
              {data.visitorUserId}
            </span>
          ) : (
            EMPTY
          )}
        </Row>
        <Row label="Created">{formatDate(data.createdAtCrisp)}</Row>
        <Row label="Last message">{formatDate(data.lastMessageAt)}</Row>
        <Row label="Messages">
          <span className="tabular-nums">{data.messageCount}</span>
        </Row>
        <Row label="Attachments">
          <span className="inline-flex items-center gap-1 tabular-nums">
            {data.fileCount > 0 ? (
              <Paperclip className="text-muted-foreground size-3" aria-hidden />
            ) : null}
            {data.fileCount}
          </span>
        </Row>
      </section>

      <Separator />

      {/* Tags */}
      <section className="space-y-2">
        <SectionLabel>Tags</SectionLabel>
        {data.tags.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {data.tags.map((tag) => (
              <Badge
                key={tag}
                variant="secondary"
                className="px-1.5 py-0 text-[11px] font-normal"
              >
                {tag}
              </Badge>
            ))}
          </div>
        ) : (
          <p className="text-muted-foreground text-xs">No tags</p>
        )}
      </section>

      <Separator />

      {/* Assigned operator */}
      <section className="space-y-2">
        <SectionLabel>Assigned operator</SectionLabel>
        {data.assignedOperator ? (
          <div className="flex items-center gap-2">
            <Avatar className="size-6">
              {data.assignedOperator.avatar ? (
                <AvatarImage src={data.assignedOperator.avatar} alt="" />
              ) : null}
              <AvatarFallback className="text-[10px] font-medium">
                {initials(data.assignedOperator.name, null)}
              </AvatarFallback>
            </Avatar>
            <span className="truncate text-xs font-medium">
              {data.assignedOperator.name ?? "Operator"}
            </span>
          </div>
        ) : (
          <p className="text-muted-foreground text-xs">Unassigned</p>
        )}
      </section>

      <Separator />

      {/* RAG chunks */}
      <section className="space-y-2">
        <SectionLabel>RAG chunks</SectionLabel>
        <div className="flex items-center gap-1.5 text-xs">
          <Layers className="text-muted-foreground size-3.5 shrink-0" aria-hidden />
          <span className="tabular-nums">
            {data.chunkCount} {data.chunkCount === 1 ? "chunk" : "chunks"}
          </span>
        </div>
        {data.chunkProducts.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {data.chunkProducts.map((product) => (
              <Badge
                key={product}
                variant="outline"
                className="px-1.5 py-0 text-[11px] font-normal"
              >
                {product}
              </Badge>
            ))}
          </div>
        ) : null}
      </section>
    </div>
  );
}
