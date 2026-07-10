import { createHash } from "crypto";
import type { Prisma } from "@prisma/client";
import type {
  CrispConversation,
  CrispFileContent,
  CrispMessage,
} from "@/lib/crisp/types";

/** Convert a Crisp ms-epoch timestamp to a Date, tolerating junk. */
export function crispDate(value: unknown): Date | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return new Date(value);
}

/** Extract the plain-text rendering of a Crisp message, if any. */
export function extractMessageText(message: CrispMessage): string | null {
  const { content } = message;
  if (typeof content === "string") return content;
  if (content && typeof content === "object") {
    const obj = content as Record<string, unknown>;
    for (const key of ["text", "name", "value"]) {
      if (typeof obj[key] === "string" && (obj[key] as string).length > 0) {
        return obj[key] as string;
      }
    }
  }
  return null;
}

/**
 * Stable identifier for a message. Crisp fingerprints are unique within a
 * session; when absent, a deterministic surrogate keeps upserts idempotent.
 */
export function messageKey(message: CrispMessage): string {
  if (message.fingerprint !== undefined && message.fingerprint !== null) {
    return String(message.fingerprint);
  }
  const hash = createHash("sha256")
    .update(JSON.stringify([message.timestamp, message.type, message.from, message.content]))
    .digest("hex")
    .slice(0, 16);
  return `gen-${message.timestamp ?? 0}-${hash}`;
}

/** Column values extracted from a Crisp conversation payload. */
export function conversationToColumns(
  conversation: CrispConversation,
  websiteId: string
): Omit<Prisma.ConversationUncheckedCreateInput, "sessionId" | "assignedOperatorId"> & {
  assignedCrispUserId: string | null;
} {
  const meta = conversation.meta ?? {};
  const geolocation = meta.device?.geolocation ?? {};
  return {
    websiteId: conversation.website_id ?? websiteId,
    state: conversation.state ?? null,
    inbox: (conversation.inbox_id as string | null) ?? null,
    createdAtCrisp: crispDate(conversation.created_at),
    updatedAtCrisp: crispDate(conversation.updated_at),
    lastMessageAt:
      crispDate(conversation.active?.last) ?? crispDate(conversation.updated_at),
    lastMessagePreview:
      typeof conversation.last_message === "string"
        ? conversation.last_message
        : null,
    visitorEmail: meta.email ?? null,
    visitorNickname: meta.nickname ?? null,
    visitorAvatar: meta.avatar ?? null,
    visitorPhone: meta.phone ?? null,
    visitorUserId: (conversation.people_id as string | undefined) ?? null,
    country: geolocation.country ?? null,
    city: geolocation.city ?? null,
    ip: meta.ip ?? null,
    tags: Array.isArray(meta.segments)
      ? meta.segments.filter((s): s is string => typeof s === "string")
      : [],
    assignedCrispUserId: conversation.assigned?.user_id ?? null,
    rawJson: conversation as unknown as Prisma.InputJsonValue,
  };
}

/** Column values extracted from a Crisp message payload. */
export function messageToColumns(message: CrispMessage): {
  crispMessageId: string;
  type: string;
  from: string;
  origin: string | null;
  userId: string | null;
  operatorId: string | null;
  content: string | null;
  contentJson: Prisma.InputJsonValue | undefined;
  timestampCrisp: Date | null;
  rawJson: Prisma.InputJsonValue;
} {
  const from = message.from ?? "user";
  const senderId = message.user?.user_id ?? null;
  return {
    crispMessageId: messageKey(message),
    type: message.type ?? "text",
    from,
    origin: message.origin ?? null,
    userId: from === "user" ? senderId : null,
    operatorId: from === "operator" ? senderId : null,
    content: extractMessageText(message),
    contentJson:
      message.content && typeof message.content === "object"
        ? (message.content as Prisma.InputJsonValue)
        : undefined,
    timestampCrisp: crispDate(message.timestamp),
    rawJson: message as unknown as Prisma.InputJsonValue,
  };
}

const FILE_MESSAGE_TYPES = new Set(["file", "audio", "animation"]);

/** Extract an attachment descriptor from file-carrying messages. */
export function extractFile(message: CrispMessage): CrispFileContent | null {
  if (!FILE_MESSAGE_TYPES.has(message.type ?? "")) return null;
  const content = message.content;
  if (!content || typeof content !== "object") return null;
  const file = content as CrispFileContent;
  if (typeof file.url !== "string" || file.url.length === 0) return null;
  return file;
}
