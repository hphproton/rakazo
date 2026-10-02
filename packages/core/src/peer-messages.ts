import type { MessageBlock } from "@rakazo/contracts";
import { normalizeSpaceTopicKey } from "@rakazo/contracts";
import { hubMemberLabel, peerReceiptDisplayName } from "./bot-messages.js";

export interface PeerMessage {
  messageId: string;
  direction: "sent" | "received";
  peerBotId: string;
  peerBotName: string;
  text: string;
  createdAt: string;
  /** Set when this Hub turn carries a space join key. */
  spaceTopicKey?: string;
  /** Rakazo bot whose thread stored this turn. */
  botId?: string;
  botName?: string;
}

/** Rakazo bot named in a space-wide transcript, first appearance order. */
export interface HubTranscriptBot {
  botId: string;
  botName: string;
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
  /**
   * Rakazo bots that share one spaceTopicKey, first appearance order.
   * Absent when the transcript stays on one bot thread.
   */
  rakazoBots?: readonly HubTranscriptBot[];
}

type PeerTranscriptMessage = {
  id: string;
  blocks: readonly MessageBlock[];
  createdAt?: string;
  role?: string;
  threadId?: string;
  seq?: number;
  botId?: string;
  botName?: string;
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
        collected.push(
          withThreadSpeaker(
            {
              messageId: message.id,
              direction: "sent",
              peerBotId: block.hubAgentId,
              peerBotName: hubMemberLabel(block.name),
              text: block.text,
              createdAt: message.createdAt ?? "",
            },
            message,
            block.spaceTopicKey,
          ),
        );
        continue;
      }
      if (!isPeerBlock(block)) continue;
      if (block.kind === "bot_message_sent") {
        collected.push({
          messageId: message.id,
          direction: "sent",
          peerBotId: block.toBotId,
          peerBotName: block.toBotName,
          text: block.text,
          createdAt: message.createdAt ?? "",
        });
        continue;
      }
      const received: PeerMessage = {
        messageId: message.id,
        direction: "received",
        peerBotId: block.fromBotId,
        peerBotName: peerReceiptDisplayName(block),
        text: block.text,
        createdAt: message.createdAt ?? "",
      };
      collected.push(
        block.origin === "hub"
          ? withThreadSpeaker(received, message, block.spaceTopicKey)
          : received,
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
 * does not substitute the latest topic. Two Rakazo bots stay apart unless the
 * anchor block has a spaceTopicKey that the other bot's Hub turns also carry.
 * Two Hub members do not require one shared page. Teammate scope stays one
 * conversation per bot id.
 */
export function peerTranscriptForChip(
  messages: readonly PeerTranscriptMessage[],
  chip: PeerTranscriptChip,
): PeerConversation | null {
  if (chip.scope === "hub") return hubExchangeForAnchor(messages, chip);
  return peerConversations(messages).find((entry) => entry.peerBotId === chip.peerBotId) ?? null;
}

/**
 * Hub topic that contains this chip's message. Null when that message is absent.
 * A spaceTopicKey on the anchor includes every loaded Hub turn with that key,
 * including the other bot. No key keeps today's per-thread topic. Text and
 * timestamps do not join, and two Hub members stay on the topics they already have.
 */
export function hubExchangeForAnchor(
  messages: readonly PeerTranscriptMessage[],
  anchor: { messageId: string; peerBotId: string },
): PeerConversation | null {
  const match = hubTopics(messages).find((topic) =>
    topic.messages.some(
      (turn) => turn.messageId === anchor.messageId && turn.peerBotId === anchor.peerBotId,
    ),
  );
  if (!match) return null;
  const anchorTurn = match.messages.find(
    (turn) => turn.messageId === anchor.messageId && turn.peerBotId === anchor.peerBotId,
  );
  const key = anchorTurn?.spaceTopicKey;
  if (!key) return match;
  const turns = hubTurnsWithSpaceTopicKey(messages, key);
  if (turns.length === 0) return match;
  return toSpaceConversation(turns);
}

/** Own thread, plus other threads' messages that carry the anchor's spaceTopicKey. */
export function messagesForHubTranscript<T extends PeerTranscriptMessage>(
  ownThread: readonly T[],
  siblings: readonly T[],
  anchor: { messageId: string; peerBotId: string },
): T[] {
  const key = spaceTopicKeyOnAnchor(ownThread, anchor);
  if (!key) return [...ownThread];
  const ownThreadId = ownThread.find((message) => message.id === anchor.messageId)?.threadId;
  const related = siblings.filter((message) => {
    if (ownThreadId && message.threadId === ownThreadId) return false;
    return messageHasSpaceTopicKey(message, key);
  });
  return [...ownThread, ...related];
}

/** Key on the anchor Hub block. Missing, blank, and non-hub blocks are absent. */
export function spaceTopicKeyOnAnchor(
  messages: readonly { id: string; blocks: readonly MessageBlock[] }[],
  anchor: { messageId: string; peerBotId: string },
): string | undefined {
  const message = messages.find((entry) => entry.id === anchor.messageId);
  if (!message) return undefined;
  for (const block of message.blocks) {
    if (!blockMatchesAnchor(block, anchor.peerBotId)) continue;
    return blockSpaceTopicKey(block);
  }
  return undefined;
}

export function messageHasSpaceTopicKey(
  message: { blocks: readonly MessageBlock[] },
  key: string,
): boolean {
  return message.blocks.some((block) => blockSpaceTopicKey(block) === key);
}

/**
 * Title for the existing view-only transcript.
 * Names every Rakazo bot only when one spaceTopicKey joined more than one.
 */
export function hubTranscriptTitle(
  botName: string,
  conversation: Pick<PeerConversation, "peerBotName" | "rakazoBots">,
): string {
  const names = (conversation.rakazoBots ?? [])
    .map((bot) => bot.botName.trim())
    .filter((name) => name.length > 0);
  const speakers = names.length > 1 ? names.join(", ") : botName;
  return `${speakers} · ${conversation.peerBotName}`;
}

/**
 * Key to copy onto a hub_send_message echo.
 * The open topic on this thread must already have one. A person message on
 * this thread clears it. Another bot's thread is left alone. This does not
 * invent a key, and threadKey is not consulted.
 */
export function spaceTopicKeyForHubSend(
  messages: readonly PeerTranscriptMessage[],
  threadId: string,
  hubAgentId: string,
): string | undefined {
  const { openByThread } = walkHubTopics(messages);
  const topic = topicJoinedBySend(openByThread.get(threadId) ?? [], hubAgentId);
  if (!topic || topic.spaceTopicKeyConflict) return undefined;
  return topic.spaceTopicKey;
}

/** One collapsed direction chip on a multi-member Hub topic. */
export type HubFamilyChip = {
  direction: "sent" | "received";
  messageId: string;
  peerBotId: string;
  /** Anchor turn's member label, including the Hub prefix. */
  peerBotName: string;
  /** Member names in first-appearance order, without a Hub prefix. */
  names: readonly string[];
};

/**
 * Display plan for Hub chips on the loaded thread.
 * Topics with one member keep a chip per stored block. A topic with more than
 * one Hub member draws at most one chip per direction, on the first turn of
 * that direction, when that direction has more than one turn. The other turns
 * stay stored. `families` is keyed by `hubChipBlockKey` of the anchor turn.
 */
export type HubTopicChipPlan = {
  families: ReadonlyMap<string, HubFamilyChip>;
  omittedBlockKeys: ReadonlySet<string>;
  hiddenMessageIds: ReadonlySet<string>;
};

export function hubChipBlockKey(
  messageId: string,
  peerBotId: string,
  direction: "sent" | "received",
): string {
  return `${messageId}\0${peerBotId}\0${direction}`;
}

/**
 * Collapse multi-member Hub topics to one outbound chip and one inbound chip.
 * A direction with a single turn keeps today's leg chip. Single-member topics
 * are unchanged, including a send and its reply. Both family chips use an
 * anchor `hubExchangeForAnchor` can resolve to the same topic. Topics stay on
 * one bot thread, so two Rakazo bots do not share a chip.
 */
export function hubTopicChipPlan(messages: readonly PeerTranscriptMessage[]): HubTopicChipPlan {
  const families = new Map<string, HubFamilyChip>();
  const omittedBlockKeys = new Set<string>();
  const omittedMessageIds = new Set<string>();
  const keptMessageIds = new Set<string>();

  for (const topic of hubTopics(messages)) {
    const memberCount = new Set(topic.messages.map((turn) => turn.peerBotId)).size;
    if (memberCount < 2) {
      for (const turn of topic.messages) keptMessageIds.add(turn.messageId);
      continue;
    }
    for (const direction of ["sent", "received"] as const) {
      const turns = topic.messages.filter((turn) => turn.direction === direction);
      const anchor = turns[0];
      if (!anchor) continue;
      if (turns.length < 2) {
        keptMessageIds.add(anchor.messageId);
        continue;
      }
      const names: string[] = [];
      const seen = new Set<string>();
      for (const turn of turns) {
        if (seen.has(turn.peerBotId)) continue;
        seen.add(turn.peerBotId);
        names.push(hubShortName(turn.peerBotName));
      }
      const anchorKey = hubChipBlockKey(anchor.messageId, anchor.peerBotId, direction);
      families.set(anchorKey, {
        direction,
        messageId: anchor.messageId,
        peerBotId: anchor.peerBotId,
        peerBotName: anchor.peerBotName,
        names,
      });
      keptMessageIds.add(anchor.messageId);
      for (const turn of turns.slice(1)) {
        const key = hubChipBlockKey(turn.messageId, turn.peerBotId, direction);
        if (key !== anchorKey) omittedBlockKeys.add(key);
        omittedMessageIds.add(turn.messageId);
      }
    }
  }

  const hiddenMessageIds = new Set<string>();
  for (const messageId of omittedMessageIds) {
    if (!keptMessageIds.has(messageId)) hiddenMessageIds.add(messageId);
  }
  return { families, omittedBlockKeys, hiddenMessageIds };
}

/** A row whose only blocks are Hub chips. Teammate receipts are not included. */
export function isHubOnlyReceipt(blocks: readonly MessageBlock[]): boolean {
  return (
    blocks.length > 0 &&
    blocks.every(
      (block) =>
        block.kind === "hub_message_sent" ||
        (block.kind === "bot_message_received" && block.origin === "hub"),
    )
  );
}

/** True when a Hub-only row was folded into another direction chip. */
export function hubReceiptRowHidden(
  plan: HubTopicChipPlan,
  message: { id: string; blocks: readonly MessageBlock[] },
): boolean {
  return plan.hiddenMessageIds.has(message.id) && isHubOnlyReceipt(message.blocks);
}

/**
 * Speaker line for one turn.
 * On a multi-party Hub topic an outbound names the Hub member it addressed.
 * A single peer keeps the Rakazo bot's name on sent turns.
 */
export function peerTurnSpeaker(
  turn: Pick<PeerMessage, "direction" | "peerBotName" | "botName">,
  botName: string,
  participantCount: number,
): string {
  const speaker = turn.botName?.trim() || botName;
  if (turn.direction === "received") return turn.peerBotName;
  if (participantCount > 1) return `${speaker} · ${turn.peerBotName}`;
  return speaker;
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
  spaceTopicKey?: string;
  spaceTopicKeyConflict?: boolean;
};

function walkHubTopics(messages: readonly PeerTranscriptMessage[]): {
  done: OpenHubTopic[];
  openByThread: Map<string, OpenHubTopic[]>;
} {
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

  return { done, openByThread };
}

function hubTopics(messages: readonly PeerTranscriptMessage[]): PeerConversation[] {
  const { done, openByThread } = walkHubTopics(messages);
  const finished = [...done];
  for (const open of openByThread.values()) finished.push(...open);
  return finished.filter((topic) => topic.turns.length > 0).map(toConversation);
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
    noteSpaceTopicKey(topic, turn.spaceTopicKey);
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
  noteSpaceTopicKey(topic, turn.spaceTopicKey);
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

function hubShortName(peerBotName: string): string {
  const prefixed = peerBotName.startsWith("Hub · ");
  const name = prefixed ? peerBotName.slice("Hub · ".length) : peerBotName;
  return name || "Hub";
}

function hubTopicLabel(participants: readonly PeerParticipant[]): string {
  const first = participants[0]?.peerBotName ?? "Hub";
  if (participants.length <= 1) return first;
  const names = participants.map((participant) => hubShortName(participant.peerBotName));
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

function withThreadSpeaker(
  turn: PeerMessage,
  message: PeerTranscriptMessage,
  spaceTopicKey: string | undefined,
): PeerMessage {
  const key = normalizeSpaceTopicKey(spaceTopicKey);
  return {
    ...turn,
    ...(key ? { spaceTopicKey: key } : {}),
    ...(message.botId ? { botId: message.botId } : {}),
    ...(message.botName ? { botName: message.botName } : {}),
  };
}

function noteSpaceTopicKey(topic: OpenHubTopic, key: string | undefined) {
  if (!key || topic.spaceTopicKeyConflict) return;
  if (!topic.spaceTopicKey) {
    topic.spaceTopicKey = key;
    return;
  }
  if (topic.spaceTopicKey !== key) {
    topic.spaceTopicKeyConflict = true;
    topic.spaceTopicKey = undefined;
  }
}

function topicJoinedBySend(
  open: readonly OpenHubTopic[],
  hubAgentId: string,
): OpenHubTopic | undefined {
  const preview: PeerMessage = {
    messageId: "",
    direction: "sent",
    peerBotId: hubAgentId,
    peerBotName: "",
    text: "",
    createdAt: "",
  };
  for (let index = open.length - 1; index >= 0; index -= 1) {
    const topic = open[index];
    if (!topic) continue;
    const member = topic.participants.get(hubAgentId);
    if (!member || member.closed) continue;
    if (splitsHubMember(topic, member, preview)) break;
    return topic;
  }
  for (let index = open.length - 1; index >= 0; index -= 1) {
    const topic = open[index];
    if (!topic || topic.spoke) continue;
    return topic;
  }
  return undefined;
}

function hubTurnsWithSpaceTopicKey(
  messages: readonly PeerTranscriptMessage[],
  key: string,
): PeerMessage[] {
  const ordered = messages
    .map((message, index) => ({ message, index }))
    .sort((a, b) => compareSpaceTranscriptOrder(a.message, a.index, b.message, b.index));
  const turns: PeerMessage[] = [];
  for (const { message } of ordered) {
    for (const turn of hubTurnsFrom(message)) {
      if (turn.spaceTopicKey === key) turns.push(turn);
    }
  }
  return turns;
}

function compareSpaceTranscriptOrder(
  a: PeerTranscriptMessage,
  aIndex: number,
  b: PeerTranscriptMessage,
  bIndex: number,
): number {
  const time = (a.createdAt ?? "").localeCompare(b.createdAt ?? "");
  if (time !== 0) return time;
  const thread = (a.threadId ?? "").localeCompare(b.threadId ?? "");
  if (thread !== 0) return thread;
  if (a.seq != null && b.seq != null && a.seq !== b.seq) return a.seq - b.seq;
  return aIndex - bIndex;
}

function toSpaceConversation(turns: PeerMessage[]): PeerConversation {
  const order: string[] = [];
  const names = new Map<string, string>();
  for (const turn of turns) {
    if (!names.has(turn.peerBotId)) order.push(turn.peerBotId);
    names.set(turn.peerBotId, turn.peerBotName);
  }
  const participants = order.map((id) => ({
    peerBotId: id,
    peerBotName: names.get(id) ?? "Hub",
  }));
  const last = turns.at(-1);
  const rakazoBots = rakazoBotsFrom(turns);
  return {
    peerBotId: participants[0]?.peerBotId ?? last?.peerBotId ?? "",
    peerBotName: hubTopicLabel(participants),
    messages: turns,
    lastText: last?.text ?? "",
    lastAt: last?.createdAt ?? "",
    ...(participants.length > 1 ? { participants } : {}),
    ...(rakazoBots.length > 1 ? { rakazoBots } : {}),
  };
}

function rakazoBotsFrom(turns: readonly PeerMessage[]): HubTranscriptBot[] {
  const bots: HubTranscriptBot[] = [];
  const seen = new Set<string>();
  for (const turn of turns) {
    const botId = turn.botId;
    const botName = turn.botName?.trim();
    if (!botId || !botName || seen.has(botId)) continue;
    seen.add(botId);
    bots.push({ botId, botName });
  }
  return bots;
}

function blockMatchesAnchor(block: MessageBlock, peerBotId: string): boolean {
  if (block.kind === "hub_message_sent") return block.hubAgentId === peerBotId;
  return (
    block.kind === "bot_message_received" && block.origin === "hub" && block.fromBotId === peerBotId
  );
}

function blockSpaceTopicKey(block: MessageBlock): string | undefined {
  if (block.kind === "hub_message_sent") return normalizeSpaceTopicKey(block.spaceTopicKey);
  if (block.kind === "bot_message_received" && block.origin === "hub") {
    return normalizeSpaceTopicKey(block.spaceTopicKey);
  }
  return undefined;
}
