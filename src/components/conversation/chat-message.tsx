import { format } from "date-fns";
import { ExternalLink, FileText, Info, Mail, StickyNote } from "lucide-react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";

/** Plain (JSON-serializable) message shape rendered by the chat view. */
export interface ChatMessageData {
  id: string;
  type: string; // text | file | audio | animation | picker | field | note | event
  from: string; // user | operator
  origin: string | null;
  content: string | null;
  timestampCrisp: string | null; // ISO string
  senderName: string;
  senderAvatar: string | null;
}

export interface ChatMessageFile {
  url: string;
  filename: string | null;
  mimeType: string | null;
  size: number | null;
}

function formatFileSize(bytes: number | null): string | null {
  if (bytes == null || bytes <= 0) return null;
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}

function initials(name: string): string {
  const parts = name.split(/[\s@._-]+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0].charAt(0) + parts[1].charAt(0)).toUpperCase();
  }
  return name.slice(0, 2).toUpperCase() || "?";
}

function Timestamp({
  timestampCrisp,
  origin,
  className,
}: {
  timestampCrisp: string | null;
  origin: string | null;
  className?: string;
}) {
  if (!timestampCrisp && origin !== "email") return null;
  return (
    <span
      className={cn(
        "text-muted-foreground mt-1 flex items-center gap-1 px-1 text-[11px]",
        className
      )}
    >
      {timestampCrisp
        ? format(new Date(timestampCrisp), "HH:mm · MMM d, yyyy")
        : null}
      {origin === "email" ? (
        <Mail className="size-3" aria-label="Sent via email" />
      ) : null}
    </span>
  );
}

function AttachmentList({
  files,
  onDark,
}: {
  files: ChatMessageFile[];
  onDark: boolean;
}) {
  return (
    <div className="mt-1.5 flex flex-col gap-1.5 first:mt-0">
      {files.map((file, index) => {
        const isImage = file.mimeType?.startsWith("image/") ?? false;
        if (isImage) {
          return (
            <a
              key={`${file.url}-${index}`}
              href={file.url}
              target="_blank"
              rel="noreferrer"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={file.url}
                alt={file.filename ?? "Image attachment"}
                loading="lazy"
                className="max-h-64 rounded-lg border"
              />
            </a>
          );
        }
        const size = formatFileSize(file.size);
        return (
          <a
            key={`${file.url}-${index}`}
            href={file.url}
            target="_blank"
            rel="noreferrer"
            className={cn(
              "flex items-center gap-2.5 rounded-lg border px-3 py-2 transition-colors",
              onDark
                ? "border-white/25 bg-white/10 hover:bg-white/20"
                : "bg-background hover:bg-accent"
            )}
          >
            <FileText className="size-4 shrink-0 opacity-80" aria-hidden />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs font-medium">
                {file.filename || "Attachment"}
              </span>
              {size ? (
                <span
                  className={cn(
                    "block text-[11px]",
                    onDark ? "text-white/70" : "text-muted-foreground"
                  )}
                >
                  {size}
                </span>
              ) : null}
            </span>
            <ExternalLink className="size-3.5 shrink-0 opacity-70" aria-hidden />
          </a>
        );
      })}
    </div>
  );
}

/**
 * Single message in the conversation transcript. Visitor messages align
 * left, operator messages align right (blue), private notes and events
 * render centered.
 */
export function ChatMessage({
  message,
  files = [],
}: {
  message: ChatMessageData;
  files?: ChatMessageFile[];
}) {
  // Private operator note — centered amber card.
  if (message.type === "note") {
    return (
      <div className="flex flex-col items-center py-1">
        <div className="w-full max-w-md rounded-lg border border-amber-200 bg-amber-100/70 px-4 py-3 text-amber-950 dark:border-amber-500/25 dark:bg-amber-500/10 dark:text-amber-100">
          <div className="flex items-center gap-1.5 text-[11px] font-medium tracking-wide text-amber-700 uppercase dark:text-amber-400">
            <StickyNote className="size-3.5" aria-hidden />
            Private note
            <span className="text-amber-700/70 ml-auto normal-case dark:text-amber-400/70">
              {message.senderName}
            </span>
          </div>
          {message.content ? (
            <p className="mt-1.5 text-sm break-words whitespace-pre-wrap">
              {message.content}
            </p>
          ) : null}
          {files.length > 0 ? (
            <AttachmentList files={files} onDark={false} />
          ) : null}
        </div>
        <Timestamp
          timestampCrisp={message.timestampCrisp}
          origin={message.origin}
        />
      </div>
    );
  }

  // System / lifecycle event — centered gray pill.
  if (message.type === "event") {
    return (
      <div className="flex flex-col items-center py-1">
        <span className="bg-muted text-muted-foreground inline-flex max-w-md items-center gap-1.5 rounded-full px-3 py-1 text-xs">
          <Info className="size-3 shrink-0" aria-hidden />
          <span className="truncate">{message.content || "Event"}</span>
        </span>
        <Timestamp
          timestampCrisp={message.timestampCrisp}
          origin={message.origin}
        />
      </div>
    );
  }

  const isOperator = message.from === "operator";
  const hasBody = Boolean(message.content) || files.length > 0;

  return (
    <div
      className={cn(
        "flex items-end gap-2",
        isOperator ? "flex-row-reverse" : "flex-row"
      )}
    >
      <Avatar className="size-7 shrink-0">
        {message.senderAvatar ? (
          <AvatarImage src={message.senderAvatar} alt="" />
        ) : null}
        <AvatarFallback className="text-[10px] font-medium">
          {initials(message.senderName)}
        </AvatarFallback>
      </Avatar>

      <div
        className={cn(
          "flex max-w-[78%] min-w-0 flex-col",
          isOperator ? "items-end" : "items-start"
        )}
      >
        {isOperator ? (
          <span className="text-muted-foreground mb-0.5 px-1 text-[11px]">
            {message.senderName}
          </span>
        ) : null}

        <div
          className={cn(
            "rounded-2xl px-3.5 py-2",
            isOperator
              ? "rounded-br-sm bg-blue-600 text-white"
              : "bg-muted rounded-bl-sm"
          )}
        >
          {message.content ? (
            <p className="text-sm break-words whitespace-pre-wrap">
              {message.content}
            </p>
          ) : null}
          {files.length > 0 ? (
            <AttachmentList files={files} onDark={isOperator} />
          ) : null}
          {!hasBody ? (
            <p
              className={cn(
                "text-sm italic",
                isOperator ? "text-white/70" : "text-muted-foreground"
              )}
            >
              No text content ({message.type})
            </p>
          ) : null}
        </div>

        <Timestamp
          timestampCrisp={message.timestampCrisp}
          origin={message.origin}
        />
      </div>
    </div>
  );
}
