import type { MessageBlock } from "@rakazo/contracts";
import { hubMemberLabel, peerReceiptDisplayName } from "./bot-messages.js";

export interface PeerMessage {
  messageId: string;
  direction: "sent" | "received";
  peerBotId: string;
  peerBotName: string;
  text: string;
  createdAt: string;
}

export interface PeerConversation {
  peerBotId: string;
  peerBotName: string;
  messages: PeerMessage[];
  lastText: string;
  lastAt: string;
}

type PeerTranscriptMessage = {
  id: string;
  blocks: readonly MessageBlock[];
  createdAt?: string;
  role?: string;
  threadId?: string;
  seq?: number;
};

type PeerBlock = Extract<MessageBlock, { kind: "bot_message_sent" | "bot_message_received" }>;

export function isPeerBlock(block: MessageBlock): block is PeerBlock {
  return block.kind === "bot_message_sent" || block.kind === "bot_message_received";
}

/**
 * Turns that belong in a view-only 1:1 transcript.
 * A Hub inbound receipt and a `hub_message_sent` echo both use `hubAgentId` as
 * the peer id. That id is not a sidebar seat, and it is not the transcript a
 * chip opens: several exchanges with one member must stay separate.
 */
export function peerMessagesFrom(messages: readonly PeerTranscriptMessage[]): PeerMessage[] {
  const collected: PeerMessage[] = [];
  for (const message of messages) {
    for (const block of message.blocks) {
      if (block.kind === "hub_message_sent") {
        collected.push({
          messageId: message.id,
          direction: "sent",
          peerBotId: block.hubAgentId,
          peerBotName: hubMemberLabel(block.name),
          text: block.text,
          createdAt: message.createdAt ?? "",
        });
        continue;
      }
      if (!isPeerBlock(block)) continue;
      collected.push(
        block.kind === "bot_message_sent"
          ? {
              messageId: message.id,
              direction: "sent",
              peerBotId: block.toBotId,
              peerBotName: block.toBotName,
              text: block.text,
              createdAt: message.createdAt ?? "",
            }
          : {
              messageId: message.id,
              direction: "received",
              peerBotId: block.fromBotId,
              peerBotName: peerReceiptDisplayName(block),
              text: block.text,
              createdAt: message.createdAt ?? "",
            },
      );
    }
  }
  return collected;
}

/**
 * One bag per peer id, most recently active first.
 * Hub turns are folded in by `hubAgentId` only. Do not open a chip from this
 * list: that lookup shows every exchange with the member, including a later
 * one. Use `peerTranscriptForChip`.
 */
export function peerConversations(messages: readonly PeerTranscriptMessage[]): PeerConversation[] {
  const byPeer = new Map<string, PeerConversation>();
  for (const peerMessage of peerMessagesFrom(messages)) {
    const existing = byPeer.get(peerMessage.peerBotId);
    if (existing) {
      existing.messages.push(peerMessage);
      continue;
    }
    byPeer.set(peerMessage.peerBotId, {
      peerBotId: peerMessage.peerBotId,
      peerBotName: peerMessage.peerBotName,
      messages: [peerMessage],
      lastText: peerMessage.text,
      lastAt: peerMessage.createdAt,
    });
  }
  for (const conversation of byPeer.values()) {
    conversation.messages.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const last = conversation.messages.at(-1);
    if (!last) continue;
    conversation.peerBotName = last.peerBotName;
    conversation.lastText = last.text;
    conversation.lastAt = last.createdAt;
  }
  return [...byPeer.values()].sort((a, b) => b.lastAt.localeCompare(a.lastAt));
}

export type PeerTranscriptChip = {
  scope: "hub" | "peer";
  messageId: string;
  peerBotId: string;
};

/**
 * Transcript for the chip that was clicked.
 *
 * Hub scope is one exchange on one bot thread for one `hubAgentId`. A person
 * message ends it. A person message is a `user` row that is not itself a Hub
 * or teammate receipt. A bot text reply also ends it when the next Hub turn
 * repeats a direction already present, or the exchange already has both
 * directions. The missing direction of an incomplete exchange still joins
 * after that reply, so one inbound and the outbound that answers it stay
 * together. The result is the exchange that contains `messageId`. A miss
 * returns null and does not substitute the latest exchange for that member.
 *
 * There is no Hub topic id on the stored block. `threadKey` on the outbox is
 * not copied onto the echo, so a burst with no person message and no bot
 * reply stays one exchange. Two Rakazo bots stay apart because their messages
 * carry different `threadId`s. Teammate scope stays one conversation per bot id.
 */
export function peerTranscriptForChip(
  messages: readonly PeerTranscriptMessage[],
  chip: PeerTranscriptChip,
): PeerConversation | null {
  if (chip.scope === "hub") return hubExchangeForAnchor(messages, chip);
  return peerConversations(messages).find((entry) => entry.peerBotId === chip.peerBotId) ?? null;
}

/** Hub exchange that contains this chip's message. Null when that message is absent. */
export function hubExchangeForAnchor(
  messages: readonly PeerTranscriptMessage[],
  anchor: { messageId: string; peerBotId: string },
): PeerConversation | null {
  const match = hubExchanges(messages).find(
    (exchange) =>
      exchange.peerBotId === anchor.peerBotId &&
      exchange.messages.some((turn) => turn.messageId === anchor.messageId),
  );
  return match ?? null;
}

type OpenHubExchange = {
  sent: boolean;
  received: boolean;
  /** A bot text reply to the person has landed since the previous Hub turn. */
  botTextSince: boolean;
};

function hubExchanges(messages: readonly PeerTranscriptMessage[]): PeerConversation[] {
  const ordered = messages
    .map((message, index) => ({ message, index }))
    .sort((a, b) => compareTranscriptOrder(a.message, a.index, b.message, b.index));
  const generationByMember = new Map<string, number>();
  const openByMember = new Map<string, OpenHubExchange>();
  const byExchange = new Map<string, PeerMessage[]>();

  for (const { message } of ordered) {
    const threadId = message.threadId ?? "";
    const hubTurns = hubTurnsFrom(message);
    if (hubTurns.length > 0) {
      for (const turn of hubTurns) {
        const memberKey = `${threadId}\0${turn.peerBotId}`;
        const generation = generationForTurn(
          memberKey,
          turn.direction,
          generationByMember,
          openByMember,
        );
        const key = `${memberKey}\0${generation}`;
        const turns = byExchange.get(key);
        if (turns) turns.push(turn);
        else byExchange.set(key, [turn]);
      }
      continue;
    }
    if (isPersonAuthoredMessage(message)) {
      closeHubExchanges(threadId, generationByMember, openByMember);
      continue;
    }
    if (isBotReplyText(message)) noteBotReply(threadId, openByMember);
  }

  const exchanges: PeerConversation[] = [];
  for (const turns of byExchange.values()) {
    const last = turns.at(-1);
    if (!last) continue;
    exchanges.push({
      peerBotId: last.peerBotId,
      peerBotName: last.peerBotName,
      messages: turns,
      lastText: last.text,
      lastAt: last.createdAt,
    });
  }
  return exchanges;
}

function compareTranscriptOrder(
  a: PeerTranscriptMessage,
  aIndex: number,
  b: PeerTranscriptMessage,
  bIndex: number,
): number {
  const thread = (a.threadId ?? "").localeCompare(b.threadId ?? "");
  if (thread !== 0) return thread;
  if (a.seq != null && b.seq != null && a.seq !== b.seq) return a.seq - b.seq;
  const time = (a.createdAt ?? "").localeCompare(b.createdAt ?? "");
  if (time !== 0) return time;
  return aIndex - bIndex;
}

/** A person typed this. Hub and teammate receipts stay inside the open exchange. */
function isPersonAuthoredMessage(message: PeerTranscriptMessage): boolean {
  if (message.role !== "user") return false;
  return !message.blocks.some(
    (block) =>
      block.kind === "hub_message_sent" ||
      block.kind === "bot_message_sent" ||
      block.kind === "bot_message_received",
  );
}

function isBotReplyText(message: PeerTranscriptMessage): boolean {
  if (message.role === "user") return false;
  return message.blocks.some((block) => block.kind === "text" && block.text.trim().length > 0);
}

function generationForTurn(
  memberKey: string,
  direction: PeerMessage["direction"],
  generationByMember: Map<string, number>,
  openByMember: Map<string, OpenHubExchange>,
): number {
  const open = openByMember.get(memberKey);
  if (!open) {
    if (!generationByMember.has(memberKey)) generationByMember.set(memberKey, 0);
    openByMember.set(memberKey, {
      sent: direction === "sent",
      received: direction === "received",
      botTextSince: false,
    });
    return generationByMember.get(memberKey) ?? 0;
  }
  const repeats =
    (direction === "sent" && open.sent) || (direction === "received" && open.received);
  const complete = open.sent && open.received;
  if (open.botTextSince && (repeats || complete)) {
    generationByMember.set(memberKey, (generationByMember.get(memberKey) ?? 0) + 1);
    openByMember.set(memberKey, {
      sent: direction === "sent",
      received: direction === "received",
      botTextSince: false,
    });
    return generationByMember.get(memberKey) ?? 0;
  }
  if (direction === "sent") open.sent = true;
  else open.received = true;
  open.botTextSince = false;
  return generationByMember.get(memberKey) ?? 0;
}

function closeHubExchanges(
  threadId: string,
  generationByMember: Map<string, number>,
  openByMember: Map<string, OpenHubExchange>,
) {
  const prefix = `${threadId}\0`;
  for (const memberKey of [...openByMember.keys()]) {
    if (!memberKey.startsWith(prefix)) continue;
    const open = openByMember.get(memberKey);
    if (open && (open.sent || open.received)) {
      generationByMember.set(memberKey, (generationByMember.get(memberKey) ?? 0) + 1);
    }
    openByMember.delete(memberKey);
  }
}

function noteBotReply(threadId: string, openByMember: Map<string, OpenHubExchange>) {
  const prefix = `${threadId}\0`;
  for (const [memberKey, open] of openByMember) {
    if (memberKey.startsWith(prefix)) open.botTextSince = true;
  }
}

function hubTurnsFrom(message: PeerTranscriptMessage): PeerMessage[] {
  return peerMessagesFrom([message]).filter((turn) =>
    message.blocks.some(
      (block) =>
        (block.kind === "hub_message_sent" && block.hubAgentId === turn.peerBotId) ||
        (block.kind === "bot_message_received" &&
          block.origin === "hub" &&
          block.fromBotId === turn.peerBotId),
    ),
  );
}
