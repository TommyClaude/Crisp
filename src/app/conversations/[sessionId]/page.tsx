import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, MessagesSquare } from "lucide-react";

import {
  ChatMessage,
  type ChatMessageData,
  type ChatMessageFile,
} from "@/components/conversation/chat-message";
import { DetailActions } from "@/components/conversation/detail-actions";
import {
  StateBadge,
  VisitorPanel,
  type VisitorPanelData,
} from "@/components/conversation/visitor-panel";
import { getConversationDetail } from "@/lib/conversations";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Conversation" };

/** Best-effort read of the sender identity embedded in a message's rawJson. */
function senderFromRaw(raw: unknown): {
  nickname: string | null;
  avatar: string | null;
} {
  if (raw && typeof raw === "object" && "user" in raw) {
    const user = (raw as { user?: unknown }).user;
    if (user && typeof user === "object") {
      const u = user as { nickname?: unknown; avatar?: unknown };
      return {
        nickname: typeof u.nickname === "string" && u.nickname ? u.nickname : null,
        avatar: typeof u.avatar === "string" && u.avatar ? u.avatar : null,
      };
    }
  }
  return { nickname: null, avatar: null };
}

export default async function ConversationDetailPage({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const { sessionId: rawSessionId } = await params;
  const sessionId = decodeURIComponent(rawSessionId);

  const conversation = await getConversationDetail(sessionId);
  if (!conversation) notFound();

  const visitorName =
    conversation.visitorNickname || conversation.visitorEmail || "Anonymous";
  const operatorName = conversation.assignedOperator?.name || "Operator";
  const operatorAvatar = conversation.assignedOperator?.avatar ?? null;

  // Attach each stored file to the message it came from.
  const filesByMessage = new Map<string, ChatMessageFile[]>();
  for (const file of conversation.files) {
    if (!file.messageId) continue;
    const plain: ChatMessageFile = {
      url: file.url,
      filename: file.filename,
      mimeType: file.mimeType,
      size: file.size,
    };
    const list = filesByMessage.get(file.messageId);
    if (list) list.push(plain);
    else filesByMessage.set(file.messageId, [plain]);
  }

  // Serialize messages to plain props (Dates -> ISO strings) and resolve
  // the sender identity from rawJson with sensible fallbacks.
  const messages: Array<{ data: ChatMessageData; files: ChatMessageFile[] }> =
    conversation.messages.map((m) => {
      const sender = senderFromRaw(m.rawJson);
      const isOperator = m.from === "operator";
      return {
        data: {
          id: m.id,
          type: m.type,
          from: m.from,
          origin: m.origin,
          content: m.content,
          timestampCrisp: m.timestampCrisp?.toISOString() ?? null,
          senderName:
            sender.nickname ?? (isOperator ? operatorName : visitorName),
          senderAvatar:
            sender.avatar ??
            (isOperator ? operatorAvatar : conversation.visitorAvatar),
        },
        files: filesByMessage.get(m.id) ?? [],
      };
    });

  const chunkProducts = Array.from(
    new Set(
      conversation.chunks
        .map((c) => c.product)
        .filter((p): p is string => Boolean(p))
    )
  ).sort();

  const panelData: VisitorPanelData = {
    sessionId: conversation.sessionId,
    state: conversation.state,
    visitorEmail: conversation.visitorEmail,
    visitorNickname: conversation.visitorNickname,
    visitorAvatar: conversation.visitorAvatar,
    visitorPhone: conversation.visitorPhone,
    visitorUserId: conversation.visitorUserId,
    country: conversation.country,
    city: conversation.city,
    ip: conversation.ip,
    tags: conversation.tags,
    createdAtCrisp: conversation.createdAtCrisp?.toISOString() ?? null,
    lastMessageAt: conversation.lastMessageAt?.toISOString() ?? null,
    messageCount: conversation.messages.length,
    fileCount: conversation.files.length,
    assignedOperator: conversation.assignedOperator
      ? {
          crispUserId: conversation.assignedOperator.crispUserId,
          name: conversation.assignedOperator.name,
          avatar: conversation.assignedOperator.avatar,
        }
      : null,
    chunkCount: conversation.chunks.length,
    chunkProducts,
  };

  return (
    <div className="flex min-h-screen flex-col">
      {/* Sticky header bar */}
      <header className="bg-background/90 supports-[backdrop-filter]:bg-background/75 sticky top-0 z-10 border-b backdrop-blur">
        <div className="flex items-center gap-3 px-6 py-3">
          <Link
            href="/conversations"
            aria-label="Back to conversations"
            className="text-muted-foreground hover:bg-accent hover:text-foreground -ml-2 shrink-0 rounded-md p-1.5 transition-colors"
          >
            <ArrowLeft className="size-4" />
          </Link>
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <h1 className="truncate text-sm font-semibold">{visitorName}</h1>
            <StateBadge state={conversation.state} />
            <span
              className="text-muted-foreground hidden max-w-48 truncate font-mono text-xs md:inline"
              title={conversation.sessionId}
            >
              {conversation.sessionId}
            </span>
          </div>
          <DetailActions
            sessionId={conversation.sessionId}
            websiteId={conversation.websiteId}
          />
        </div>
      </header>

      <div className="flex flex-1 items-stretch">
        {/* Chat transcript */}
        <section className="min-w-0 flex-1 px-6 py-6">
          <div className="mx-auto w-full max-w-3xl space-y-3">
            {messages.length === 0 ? (
              <div className="bg-card flex flex-col items-center rounded-lg border px-6 py-16 text-center">
                <MessagesSquare
                  className="text-muted-foreground/50 size-10"
                  aria-hidden
                />
                <h2 className="mt-4 text-sm font-semibold">No messages</h2>
                <p className="text-muted-foreground mt-1 max-w-sm text-sm">
                  This conversation has no synced messages yet. Try a resync to
                  pull the transcript from Crisp.
                </p>
              </div>
            ) : (
              messages.map(({ data, files }) => (
                <ChatMessage key={data.id} message={data} files={files} />
              ))
            )}
          </div>
        </section>

        {/* Visitor panel */}
        <aside className="hidden w-80 shrink-0 border-l lg:block">
          <div className="sticky top-[57px] max-h-[calc(100vh-57px)] overflow-y-auto">
            <VisitorPanel data={panelData} />
          </div>
        </aside>
      </div>
    </div>
  );
}
