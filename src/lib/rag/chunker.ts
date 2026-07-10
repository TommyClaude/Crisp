import type { Conversation, Message } from "@prisma/client";
import { redactText } from "./redact";
import { detectPrimaryProduct } from "./products";

/**
 * Converts a synced conversation into clean retrieval chunks for RAG.
 *
 * Each chunk is a set of customer→operator exchanges with a metadata header
 * (sessionId, date, product, tags, language) so the retrieved text is
 * self-describing when pasted into an LLM prompt. PII is redacted from
 * chunkText; originals stay in the raw database only.
 */

export interface BuiltChunk {
  chunkIndex: number;
  messageIds: string[];
  chunkText: string;
  product: string | null;
  topic: string | null;
  language: string | null;
  rawJson: {
    exchangeCount: number;
    header: Record<string, string>;
  };
}

interface Exchange {
  customerLines: string[];
  operatorLines: string[];
  messageIds: string[];
}

/** Target size for a chunk's body text, in characters (~350-400 tokens). */
const MAX_CHUNK_CHARS = 1600;

/** Message types that carry conversational content worth embedding. */
const CONTENT_TYPES = new Set(["text", "file", "audio", "animation", "picker", "field"]);

function messageToLine(message: Message): string | null {
  if (!CONTENT_TYPES.has(message.type)) return null;
  if (message.type === "text") {
    const text = message.content?.trim();
    return text ? text : null;
  }
  if (["file", "audio", "animation"].includes(message.type)) {
    const content = message.contentJson as { name?: string; type?: string } | null;
    const label = content?.name || content?.type || message.type;
    return `[attachment: ${label}]`;
  }
  // picker/field — capture the visible text/value if present.
  const content = message.contentJson as { text?: string; value?: string } | null;
  const text = content?.text || content?.value;
  return text ? text : null;
}

/** Group messages into customer→operator exchanges, skipping events/notes. */
function buildExchanges(messages: Message[]): Exchange[] {
  const exchanges: Exchange[] = [];
  let current: Exchange | null = null;

  for (const message of messages) {
    // Private operator notes and system events never reach chunks.
    if (message.type === "note" || message.type === "event") continue;
    const line = messageToLine(message);
    if (!line) continue;

    const isCustomer = message.from === "user";
    if (isCustomer) {
      // A customer message after an operator reply starts a new exchange.
      if (current && current.operatorLines.length > 0) {
        exchanges.push(current);
        current = null;
      }
      current ??= { customerLines: [], operatorLines: [], messageIds: [] };
      current.customerLines.push(line);
    } else {
      current ??= { customerLines: [], operatorLines: [], messageIds: [] };
      current.operatorLines.push(line);
    }
    current.messageIds.push(message.id);
  }
  if (current) exchanges.push(current);
  return exchanges;
}

function renderExchange(exchange: Exchange): string {
  const parts: string[] = [];
  if (exchange.customerLines.length > 0) {
    parts.push(`Customer: ${exchange.customerLines.join("\n")}`);
  }
  if (exchange.operatorLines.length > 0) {
    parts.push(`Agent: ${exchange.operatorLines.join("\n")}`);
  }
  return parts.join("\n");
}

/** Best-effort language from Crisp meta locales (e.g. ["en-US"] → "en"). */
export function detectLanguage(conversation: Conversation): string | null {
  const raw = conversation.rawJson as {
    meta?: { device?: { locales?: string[] } };
  } | null;
  const locale = raw?.meta?.device?.locales?.[0];
  if (locale && typeof locale === "string") {
    return locale.slice(0, 2).toLowerCase();
  }
  return null;
}

/** Split an oversized text on line boundaries into <= maxChars pieces. */
function splitLongText(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];
  const pieces: string[] = [];
  let buffer = "";
  for (const line of text.split("\n")) {
    if (buffer.length + line.length + 1 > maxChars && buffer.length > 0) {
      pieces.push(buffer);
      buffer = "";
    }
    // A single pathological line longer than maxChars gets hard-split.
    if (line.length > maxChars) {
      for (let i = 0; i < line.length; i += maxChars) {
        pieces.push(line.slice(i, i + maxChars));
      }
      continue;
    }
    buffer = buffer ? `${buffer}\n${line}` : line;
  }
  if (buffer) pieces.push(buffer);
  return pieces;
}

export function buildChunksForConversation(
  conversation: Conversation,
  messages: Message[]
): BuiltChunk[] {
  const ordered = [...messages].sort(
    (a, b) =>
      (a.timestampCrisp?.getTime() ?? 0) - (b.timestampCrisp?.getTime() ?? 0)
  );
  const exchanges = buildExchanges(ordered);
  if (exchanges.length === 0) return [];

  const fullText = exchanges.map(renderExchange).join("\n");
  const product = detectPrimaryProduct(fullText, conversation.tags);
  const language = detectLanguage(conversation);
  const date = (conversation.createdAtCrisp ?? conversation.createdAt)
    .toISOString()
    .slice(0, 10);

  const firstCustomerLine = exchanges
    .flatMap((e) => e.customerLines)
    .find((l) => !l.startsWith("[attachment"));
  const topic = firstCustomerLine
    ? redactText(firstCustomerLine).slice(0, 120)
    : null;

  const header: Record<string, string> = { session: conversation.sessionId, date };
  if (product) header.product = product;
  if (conversation.tags.length > 0) {
    // Crisp segments are operator-entered free text — teams sometimes tag
    // conversations with a customer email or order/phone identifier, so tags
    // go through the same redaction as the body.
    header.tags = redactText(conversation.tags.join(", "));
  }
  if (language) header.language = language;
  const headerText = Object.entries(header)
    .map(([k, v]) => `${k[0].toUpperCase()}${k.slice(1)}: ${v}`)
    .join(" | ");

  // Pack whole exchanges into chunks up to MAX_CHUNK_CHARS.
  const chunks: BuiltChunk[] = [];
  let bodyParts: string[] = [];
  let bodyLength = 0;
  let messageIds: string[] = [];
  let exchangeCount = 0;

  const flush = () => {
    if (bodyParts.length === 0) return;
    const body = bodyParts.join("\n\n");
    for (const piece of splitLongText(body, MAX_CHUNK_CHARS * 1.5)) {
      // The body is redacted above and tags were redacted when the header was
      // built; the remaining header fields (sessionId, date, product,
      // language) are system-generated and must survive verbatim — running
      // redactText over the full header would mangle the session UUID.
      chunks.push({
        chunkIndex: chunks.length,
        messageIds,
        chunkText: `[${headerText}]\n${redactText(piece)}`,
        product,
        topic,
        language,
        rawJson: { exchangeCount, header },
      });
    }
    bodyParts = [];
    bodyLength = 0;
    messageIds = [];
    exchangeCount = 0;
  };

  for (const exchange of exchanges) {
    const rendered = renderExchange(exchange);
    if (bodyLength > 0 && bodyLength + rendered.length > MAX_CHUNK_CHARS) {
      flush();
    }
    bodyParts.push(rendered);
    bodyLength += rendered.length + 2;
    messageIds.push(...exchange.messageIds);
    exchangeCount += 1;
  }
  flush();

  return chunks;
}
