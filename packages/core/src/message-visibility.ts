import type { MessageBlock } from "@rakazo/contracts";

type PresentableMessage = {
  runId?: string;
  role?: string;
  seq?: number;
  blocks: readonly MessageBlock[];
};

export type UserVisibleMessagesOptions = {
  /**
   * Keep `bot_message_sent` / `bot_message_received` rows as compact chips
   * (web CollaborationMarker; mobile AgentEventLabel). Peer bodies stay hidden.
   * A Hub receipt (`origin: "hub"`) is still a chip. It does not hide the
   * target bot's substantive turn. A trivial acknowledgement after that chip
   * (for example "OK." or "ACK") is hidden, because the chip already records
   * receipt.
   */
  includePeerReceipts?: boolean;
  /** Peer-run ids from `run.trigger === "bot_message"` when receipts may be out of window. */
  knownPeerRunIds?: Iterable<string>;
  /**
   * Surface a peer-run's own `text` reply (e.g. a delegating bot's summary to the user)
   * alongside `ask` cards. Defaults to true for chat-thread rendering; set false for
   * contexts like sidebar previews that should stay ask-only and never echo peer chatter.
   */
  includeDelegatedReplyText?: boolean;
};

/**
 * Receipt-only replies. The Hub chip already shows that a message arrived, so
 * these must not render as the bot answering the person in the same thread.
 */
const TRIVIAL_HUB_ACKS = new Set([
  "ok",
  "okay",
  "okey",
  "o k",
  "ack",
  "acknowledged",
  "acknowledgement",
  "acknowledgment",
  "received",
  "message received",
  "got it",
  "noted",
  "roger",
  "copy that",
  "ok received",
  "received ok",
]);

export function isPeerReceiptBlocks(blocks: readonly MessageBlock[]): boolean {
  return blocks.some(
    (block) => block.kind === "bot_message_sent" || block.kind === "bot_message_received",
  );
}

function normalizeAckPhrase(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[*_`~]/g, "")
    .replace(/["'“”«»]/g, "")
    .replace(/[.!?,;:…。！？]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isTrivialAckPhrase(value: string): boolean {
  const key = normalizeAckPhrase(value);
  return key.length > 0 && TRIVIAL_HUB_ACKS.has(key);
}

/** True when every line is only a receipt word, with no other content. */
export function isTrivialHubAckText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (isTrivialAckPhrase(trimmed)) return true;
  const lines = trimmed
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.length > 0 && lines.every((line) => isTrivialAckPhrase(line));
}

function isTrivialHubAckBlocks(blocks: readonly MessageBlock[]): boolean {
  if (blocks.length === 0) return false;
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.kind === "text") {
      parts.push(block.text);
      continue;
    }
    // Narration renders as a bot bubble. Tool-status progress does not.
    if (block.kind === "progress" && block.activity !== true) {
      parts.push(block.text);
      continue;
    }
    return false;
  }
  return isTrivialHubAckText(parts.join("\n"));
}

function earliestHubReceiptAt(messages: readonly PresentableMessage[]): Map<string, number> {
  const hubReceiptAt = new Map<string, number>();
  messages.forEach((message, index) => {
    if (!message.runId) return;
    const hubReceipt = message.blocks.some(
      (block) => block.kind === "bot_message_received" && block.origin === "hub",
    );
    if (!hubReceipt) return;
    const at = message.seq ?? index;
    const previous = hubReceiptAt.get(message.runId);
    if (previous === undefined || at < previous) hubReceiptAt.set(message.runId, at);
  });
  return hubReceiptAt;
}

function isHiddenHubAck(
  message: PresentableMessage,
  index: number,
  hubReceiptAt: ReadonlyMap<string, number>,
): boolean {
  if (message.role !== "bot" || !message.runId) return false;
  const receiptAt = hubReceiptAt.get(message.runId);
  if (receiptAt === undefined) return false;
  const at = message.seq ?? index;
  if (at <= receiptAt) return false;
  return isTrivialHubAckBlocks(message.blocks);
}

/** Drop peer-run activity/replies; optionally keep sent/received receipt rows. */
export function userVisibleMessages<T extends PresentableMessage>(
  messages: readonly T[],
  options: UserVisibleMessagesOptions = {},
): T[] {
  const peerRunIds = new Set([
    ...(options.knownPeerRunIds ?? []),
    ...messages
      .filter((message) =>
        message.blocks.some(
          (block) => block.kind === "bot_message_received" && block.origin !== "hub",
        ),
      )
      .flatMap((message) => (message.runId ? [message.runId] : [])),
  ]);
  const hubReceiptAt = earliestHubReceiptAt(messages);
  const includePeerReceipts = options.includePeerReceipts === true;

  return messages.filter((message, index) => {
    if (isPeerReceiptBlocks(message.blocks)) return includePeerReceipts;
    if (isHiddenHubAck(message, index, hubReceiptAt)) return false;
    if (!message.runId || !peerRunIds.has(message.runId)) return true;
    // Keep peer-run ask cards, and (unless the caller opts out) the bot's own text reply.
    const includeText = options.includeDelegatedReplyText !== false;
    return message.blocks.some(
      (block) => block.kind === "ask" || (includeText && block.kind === "text"),
    );
  });
}
