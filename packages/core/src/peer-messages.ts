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

export interface PeerParticipant {
  peerBotId: string;
  peerBotName: string;
}

export interface PeerConversation {
  peerBotId: string;
  peerBotName: string;
  messages: PeerMessage[];
  lastText: string;
  lastAt: string;
  /**
   * Hub members in a shared topic, first appearance order.
   * Absent when the transcript is one peer.
   */
  participants?: PeerParticipant[];
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
 * Turns that belong in a view-only transcript.
 * A Hub inbound receipt and a `hub_message_sent` echo both use `hubAgentId` as
 * the peer id. That id is not a sidebar seat. A chip does not open this flat
 * list: several topics with one member must stay separate, and one topic may
 * include more than one member.
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
 * Hub scope is one topic on one bot thread. A burst of Hub turns before the
 * bot writes a reply shares that topic across `hubAgentId`s, and each of those
 * members' later replies stay in it. A person message ends every open topic
 * on the thread. For one member, a bot text reply still starts a new topic
 * when the next turn repeats a direction already present, or the topic already
 * has both directions. The missing direction of an incomplete topic still
 * joins after that reply. A new Hub member after the bot has replied starts
 * their own topic, so sequential 1:1s stay apart. The result is the topic
 * that contains `messageId` for that `peerBotId`. A miss returns null and
 * does not substitute the latest topic. Two Rakazo bots stay apart because
 * their messages carry different `threadId`s. Teammate scope stays one
 * conversation per bot id.
 */
export function peerTranscriptForChip(
  messages: readonly PeerTranscriptMessage[],
  chip: PeerTranscriptChip,
): PeerConversation | null {
  if (chip.scope === "hub") return hubExchangeForAnchor(messages, chip);
  return peerConversations(messages).find((entry) => entry.peerBotId === chip.peerBotId) ?? null;
}

/** Hub topic that contains this chip's message. Null when that message is absent. */
export function hubExchangeForAnchor(
  messages: readonly PeerTranscriptMessage[],
  anchor: { messageId: string; peerBotId: string },
): PeerConversation | null {
  const match = hubTopics(messages).find((topic) =>
    topic.messages.some(
      (turn) => turn.messageId === anchor.messageId && turn.peerBotId === anchor.peerBotId,
    ),
  );
  return match ?? null;
}

/**
 * Speaker line for one turn.
 * On a multi-party Hub topic an outbound names the Hub member it addressed.
 * A single peer keeps the Rakazo bot's name on sent turns.
 */
export function peerTurnSpeaker(
  turn: Pick<PeerMessage, "direction" | "peerBotName">,
  botName: string,
  participantCount: number,
): string {
  if (turn.direction === "received") return turn.peerBotName;
  if (participantCount > 1) return `${botName} · ${turn.peerBotName}`;
  return botName;
}

type HubMemberState = {
  sent: boolean;
  received: boolean;
  closed: boolean;
  peerBotName: string;
};

type OpenHubTopic = {
  /** A bot text reply has landed. Further Hub agents do not join. */
  spoke: boolean;
  botTextSince: boolean;
  order: string[];
  participants: Map<string, HubMemberState>;
  turns: PeerMessage[];
};

function hubTopics(messages: readonly PeerTranscriptMessage[]): PeerConversation[] {
  const ordered = messages
    .map((message, index) => ({ message, index }))
    .sort((a, b) => compareTranscriptOrder(a.message, a.index, b.message, b.index));
  const openByThread = new Map<string, OpenHubTopic[]>();
  const done: OpenHubTopic[] = [];

  for (const { message } of ordered) {
    const threadId = message.threadId ?? "";
    const hubTurns = hubTurnsFrom(message);
    if (hubTurns.length > 0) {
      const open = openTopics(openByThread, threadId);
      for (const turn of hubTurns) placeHubTurn(open, turn);
      continue;
    }
    if (isPersonAuthoredMessage(message)) {
      const open = openByThread.get(threadId);
      if (open && open.length > 0) {
        done.push(...open);
        openByThread.set(threadId, []);
      }
      continue;
    }
    if (isBotReplyText(message)) noteBotReply(openByThread.get(threadId));
  }

  for (const open of openByThread.values()) done.push(...open);
  return done.filter((topic) => topic.turns.length > 0).map(toConversation);
}

function openTopics(openByThread: Map<string, OpenHubTopic[]>, threadId: string): OpenHubTopic[] {
  const existing = openByThread.get(threadId);
  if (existing) return existing;
  const open: OpenHubTopic[] = [];
  openByThread.set(threadId, open);
  return open;
}

function placeHubTurn(open: OpenHubTopic[], turn: PeerMessage) {
  for (let index = open.length - 1; index >= 0; index -= 1) {
    const topic = open[index];
    if (!topic) continue;
    const member = topic.participants.get(turn.peerBotId);
    if (!member || member.closed) continue;
    if (splitsHubMember(topic, member, turn)) {
      member.closed = true;
      break;
    }
    if (turn.direction === "sent") member.sent = true;
    else member.received = true;
    member.peerBotName = turn.peerBotName;
    topic.botTextSince = false;
    topic.turns.push(turn);
    return;
  }
  for (let index = open.length - 1; index >= 0; index -= 1) {
    const topic = open[index];
    if (!topic || topic.spoke) continue;
    addHubParticipant(topic, turn);
    return;
  }
  const topic = emptyTopic();
  addHubParticipant(topic, turn);
  open.push(topic);
}

function splitsHubMember(topic: OpenHubTopic, member: HubMemberState, turn: PeerMessage): boolean {
  if (!topic.botTextSince) return false;
  const repeats =
    (turn.direction === "sent" && member.sent) ||
    (turn.direction === "received" && member.received);
  const complete = member.sent && member.received;
  return repeats || complete;
}

function addHubParticipant(topic: OpenHubTopic, turn: PeerMessage) {
  if (!topic.participants.has(turn.peerBotId)) topic.order.push(turn.peerBotId);
  topic.participants.set(turn.peerBotId, {
    sent: turn.direction === "sent",
    received: turn.direction === "received",
    closed: false,
    peerBotName: turn.peerBotName,
  });
  topic.botTextSince = false;
  topic.turns.push(turn);
}

function emptyTopic(): OpenHubTopic {
  return {
    spoke: false,
    botTextSince: false,
    order: [],
    participants: new Map(),
    turns: [],
  };
}

function toConversation(topic: OpenHubTopic): PeerConversation {
  const participants = topic.order.map((id) => {
    const member = topic.participants.get(id);
    return { peerBotId: id, peerBotName: member?.peerBotName ?? "Hub" };
  });
  const last = topic.turns.at(-1);
  return {
    peerBotId: participants[0]?.peerBotId ?? last?.peerBotId ?? "",
    peerBotName: hubTopicLabel(participants),
    messages: topic.turns,
    lastText: last?.text ?? "",
    lastAt: last?.createdAt ?? "",
    ...(participants.length > 1 ? { participants } : {}),
  };
}

function hubTopicLabel(participants: readonly PeerParticipant[]): string {
  const first = participants[0]?.peerBotName ?? "Hub";
  if (participants.length <= 1) return first;
  const names = participants.map((participant) => {
    const prefixed = participant.peerBotName.startsWith("Hub · ");
    const name = prefixed
      ? participant.peerBotName.slice("Hub · ".length)
      : participant.peerBotName;
    return name || "Hub";
  });
  return `Hub · ${names.join(", ")}`;
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

/** A person typed this. Hub and teammate receipts stay inside the open topic. */
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

function noteBotReply(open: OpenHubTopic[] | undefined) {
  if (!open) return;
  for (const topic of open) {
    if (topic.turns.length === 0) continue;
    topic.botTextSince = true;
    topic.spoke = true;
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
