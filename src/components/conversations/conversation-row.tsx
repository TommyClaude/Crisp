import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
import { MessageSquare, Paperclip } from "lucide-react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/** Conversation list item with dates serialized to ISO strings. */
export interface ConversationRowItem {
  id: string;
  sessionId: string;
  state: string | null;
  visitorEmail: string | null;
  visitorNickname: string | null;
  visitorAvatar: string | null;
  country: string | null;
  city: string | null;
  tags: string[];
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  updatedAtCrisp: string | null;
  createdAtCrisp: string | null;
  assignedOperator: {
    crispUserId: string;
    name: string | null;
    avatar: string | null;
  } | null;
  _count: { messages: number; files: number };
}

const STATE_STYLES: Record<string, string> = {
  resolved:
    "border-transparent bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400",
  unresolved:
    "border-transparent bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-400",
  pending:
    "border-transparent bg-zinc-100 text-zinc-600 dark:bg-zinc-500/15 dark:text-zinc-400",
};

const MAX_VISIBLE_TAGS = 3;

function initials(nickname: string | null, email: string | null): string {
  const source = nickname?.trim() || email?.trim();
  if (!source) return "?";
  const parts = source.split(/[\s@._-]+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0].charAt(0) + parts[1].charAt(0)).toUpperCase();
  }
  return source.slice(0, 2).toUpperCase();
}

export function ConversationRow({ item }: { item: ConversationRowItem }) {
  const name = item.visitorNickname || item.visitorEmail || "Anonymous";
  const visibleTags = item.tags.slice(0, MAX_VISIBLE_TAGS);
  const hiddenTagCount = item.tags.length - visibleTags.length;

  return (
    <Link
      href={`/conversations/${item.sessionId}`}
      className="hover:bg-muted flex items-start gap-3 px-4 py-3 transition-colors"
    >
      <Avatar className="mt-0.5 size-9">
        {item.visitorAvatar ? (
          <AvatarImage src={item.visitorAvatar} alt="" />
        ) : null}
        <AvatarFallback className="text-xs font-medium">
          {initials(item.visitorNickname, item.visitorEmail)}
        </AvatarFallback>
      </Avatar>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{name}</span>
          {item.state ? (
            <Badge
              className={cn(
                "capitalize",
                STATE_STYLES[item.state] ?? STATE_STYLES.pending
              )}
            >
              {item.state}
            </Badge>
          ) : null}
        </div>

        {item.lastMessagePreview ? (
          <p className="text-muted-foreground mt-0.5 truncate text-sm">
            {item.lastMessagePreview}
          </p>
        ) : null}

        {item.tags.length > 0 ? (
          <div className="mt-1.5 flex flex-wrap items-center gap-1">
            {visibleTags.map((tag) => (
              <Badge
                key={tag}
                variant="secondary"
                className="px-1.5 py-0 text-[11px] font-normal"
              >
                {tag}
              </Badge>
            ))}
            {hiddenTagCount > 0 ? (
              <Badge
                variant="secondary"
                className="px-1.5 py-0 text-[11px] font-normal"
              >
                +{hiddenTagCount}
              </Badge>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="text-muted-foreground flex shrink-0 flex-col items-end gap-1 text-xs">
        {item.lastMessageAt ? (
          <span className="whitespace-nowrap">
            {formatDistanceToNow(new Date(item.lastMessageAt), {
              addSuffix: true,
            })}
          </span>
        ) : null}
        <span className="flex items-center gap-2.5">
          <span className="flex items-center gap-1">
            <MessageSquare className="size-3.5" aria-hidden />
            {item._count.messages}
          </span>
          {item._count.files > 0 ? (
            <span className="flex items-center gap-1">
              <Paperclip className="size-3.5" aria-hidden />
              {item._count.files}
            </span>
          ) : null}
        </span>
        {item.assignedOperator ? (
          <span className="text-muted-foreground/80 max-w-40 truncate text-[11px]">
            {item.assignedOperator.name ?? "Operator"}
          </span>
        ) : null}
      </div>
    </Link>
  );
}
