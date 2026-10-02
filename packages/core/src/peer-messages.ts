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
};

type PeerBlock = Extract<MessageBlock, { kind: "bot_message_sent" | "bot_message_received" }>;

export function isPeerBlock(block: MessageBlock): block is PeerBlock {
  return block.kind === "bot_message_sent" || block.kind === "bot_message_received";
}

/**
 * Turns that belong in a view-only 1:1 transcript.
 * A Hub member's inbound receipt and `hub_message_sent` echo share `hubAgentId`,
 * so both directions open as one conversation. That id is not a sidebar seat.
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

/** One conversation per peer, most recently active first. */
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
