import type { BotMessageIntent, MessageBlock } from "@rakazo/contracts";
import { HubInboxItemSchema } from "@rakazo/contracts";
import {
  BOT_MESSAGE_MAX_LENGTH,
  HUB_SPAWN_KEY_PREFIX,
  hubAgentIdFromSpawnKey,
  resolveHubMember,
} from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";

/**
 * First-party Rakazo → Hub drain.
 *
 * This tip has no native outbound sender. Cutover still advertises `mcp`.
 * `hub_send_message` resolves a directory member and inserts a HUB-INBOX row
 * with status `wake`. A host-straight mesh lists `hub/outbox` and acks ids
 * `done`. The tool does not write a user message and does not require `TO_HUB:`.
 * On success the caller records a `hub_message_sent` echo in the sending thread
 * so the person sees the payload that left.
 */

const HUB_THREAD_KEY_MAX = 200;
const HUB_OUTBOX_LIMIT = 50;
const INTENTS = new Set<BotMessageIntent>(["request", "result", "question", "status", "fyi"]);

export type HubSendResult =
  | {
      ok: true;
      hubAgentId: string;
      name: string;
      deliveryId: string;
      text: string;
      intent: BotMessageIntent;
      meshId?: string;
      replayed?: true;
      note: string;
    }
  | { ok: false; error: "target_required" }
  | { ok: false; error: "not_found"; target: string }
  | {
      ok: false;
      error: "ambiguous";
      candidates: Array<{ hubAgentId: string; name: string; title: string }>;
    }
  | {
      ok: false;
      error:
        | "text_required"
        | "text_too_long"
        | "invalid_intent"
        | "thread_key_too_long"
        | "source_run_inactive";
    };

export function hubOutboundEchoNonce(deliveryId: string): string {
  return `hub-outbound:${deliveryId}`;
}

/** Visible echo for the sending thread. Not a teammate receipt. */
export function hubOutboundEchoBlock(input: {
  hubAgentId: string;
  name: string;
  text: string;
  intent: BotMessageIntent;
}): Extract<MessageBlock, { kind: "hub_message_sent" }> {
  return {
    kind: "hub_message_sent",
    hubAgentId: input.hubAgentId,
    name: input.name,
    text: input.text,
    intent: input.intent,
  };
}

export type HubOutboundEcho = {
  block: Extract<MessageBlock, { kind: "hub_message_sent" }>;
  nonce: string;
};

type HubSendRun = {
  id: string;
  spaceId: string;
  threadId: string;
  botId: string;
  userId: string;
};

export async function sendHubMessage(
  prisma: PrismaClient,
  run: HubSendRun,
  sender: { id: string; name: string },
  input: {
    hubAgentId?: string;
    target?: string;
    text?: string;
    intent?: string;
    threadKey?: string;
    deliveryKey?: string;
  },
  echo?: (outbound: HubOutboundEcho) => Promise<void>,
): Promise<HubSendResult> {
  const idempotencyKey = hubSendIdempotencyKey(run.spaceId, run.userId, input.deliveryKey);
  if (idempotencyKey) {
    const prior = await readReplay(prisma, run, idempotencyKey);
    if (prior) {
      await emitHubOutboundEcho(echo, prior);
      return prior;
    }
  }

  const text = input.text?.trim() ?? "";
  if (!text) return { ok: false, error: "text_required" };
  if (text.length > BOT_MESSAGE_MAX_LENGTH) return { ok: false, error: "text_too_long" };

  const intent = parseIntent(input.intent);
  if (!intent) return { ok: false, error: "invalid_intent" };

  const threadKey = parseThreadKey(input.threadKey);
  if (threadKey === "too_long") return { ok: false, error: "thread_key_too_long" };

  const hubAgentId = input.hubAgentId?.trim() ?? "";
  const target = input.target?.trim() ?? "";
  if (!hubAgentId && !target) return { ok: false, error: "target_required" };

  const rows = await prisma.bot.findMany({
    where: {
      spaceId: run.spaceId,
      userId: run.userId,
      spawnKey: { startsWith: HUB_SPAWN_KEY_PREFIX },
    },
    select: { name: true, title: true, archivedAt: true, spawnKey: true },
  });
  const members = rows.flatMap((row) => {
    const id = hubAgentIdFromSpawnKey(row.spawnKey);
    if (!id) return [];
    return [
      {
        hubAgentId: id,
        name: row.name,
        title: row.title,
        archived: row.archivedAt !== null,
      },
    ];
  });
  const resolved = resolveHubMember(members, { hubAgentId, target });
  if (!resolved.ok) return resolved;

  const running = await prisma.run.findFirst({
    where: {
      id: run.id,
      spaceId: run.spaceId,
      threadId: run.threadId,
      botId: run.botId,
      userId: run.userId,
      status: "running",
    },
    select: { id: true },
  });
  if (!running) return { ok: false, error: "source_run_inactive" };

  try {
    const created = await prisma.hubOutbound.create({
      data: {
        spaceId: run.spaceId,
        userId: run.userId,
        botId: sender.id,
        fromBotName: sender.name,
        hubAgentId: resolved.member.hubAgentId,
        name: resolved.member.name,
        title: resolved.member.title,
        text,
        intent,
        threadKey,
        status: "wake",
        idempotencyKey,
      },
      select: { id: true },
    });
    const sent: Extract<HubSendResult, { ok: true }> = {
      ok: true,
      hubAgentId: resolved.member.hubAgentId,
      name: resolved.member.name,
      deliveryId: created.id,
      text,
      intent,
      note: `Queued for ${resolved.member.name}. Delivery is async and does not end your turn.`,
    };
    await emitHubOutboundEcho(echo, sent);
    return sent;
  } catch (error) {
    if (idempotencyKey && isUniqueConstraint(error)) {
      const prior = await readReplay(prisma, run, idempotencyKey);
      if (prior) {
        await emitHubOutboundEcho(echo, prior);
        return prior;
      }
    }
    throw error;
  }
}

export async function listHubInbox(
  prisma: PrismaClient,
  actor: { spaceId: string; userId: string },
) {
  const rows = await prisma.hubOutbound.findMany({
    where: { spaceId: actor.spaceId, userId: actor.userId, status: "wake" },
    orderBy: { createdAt: "asc" },
    take: HUB_OUTBOX_LIMIT,
  });
  return rows.map((row) =>
    HubInboxItemSchema.parse({
      kind: "HUB-INBOX",
      deliveryId: row.id,
      status: "wake",
      hubAgentId: row.hubAgentId,
      name: row.name,
      title: row.title,
      text: row.text,
      intent: row.intent,
      fromBotId: row.botId,
      fromBotName: row.fromBotName,
      spaceId: row.spaceId,
      createdAt: row.createdAt.toISOString(),
      ...(row.threadKey ? { threadKey: row.threadKey } : {}),
      ...(row.meshId ? { meshId: row.meshId } : {}),
    }),
  );
}

export async function ackHubInbox(
  prisma: PrismaClient,
  actor: { spaceId: string; userId: string },
  deliveryIds: readonly string[],
) {
  const ids = [...new Set(deliveryIds.map((id) => id.trim()).filter(Boolean))].slice(0, 100);
  if (ids.length === 0) return 0;
  const result = await prisma.hubOutbound.updateMany({
    where: {
      id: { in: ids },
      spaceId: actor.spaceId,
      userId: actor.userId,
      status: "wake",
    },
    data: { status: "done" },
  });
  return result.count;
}

function parseIntent(value: string | undefined): BotMessageIntent | undefined {
  if (!value?.trim()) return "request";
  const intent = value.trim() as BotMessageIntent;
  return INTENTS.has(intent) ? intent : undefined;
}

function parseThreadKey(value: string | undefined): string | null | "too_long" {
  if (value === undefined) return null;
  const threadKey = value.trim();
  if (!threadKey) return null;
  if (threadKey.length > HUB_THREAD_KEY_MAX) return "too_long";
  return threadKey;
}

function hubSendIdempotencyKey(
  spaceId: string,
  userId: string,
  deliveryKey: string | undefined,
): string | undefined {
  const key = deliveryKey?.trim();
  if (!key) return undefined;
  return `hub-send:${spaceId}:${userId}:${key}`;
}

async function readReplay(
  prisma: PrismaClient,
  run: Pick<HubSendRun, "spaceId" | "userId">,
  idempotencyKey: string,
): Promise<Extract<HubSendResult, { ok: true }> | undefined> {
  const existing = await prisma.hubOutbound.findFirst({
    where: { idempotencyKey, spaceId: run.spaceId, userId: run.userId },
  });
  if (!existing) return undefined;
  const intent = parseIntent(existing.intent) ?? "request";
  const text = existing.text.trim();
  if (!text) return undefined;
  return {
    ok: true,
    hubAgentId: existing.hubAgentId,
    name: existing.name,
    deliveryId: existing.id,
    text,
    intent,
    ...(existing.meshId ? { meshId: existing.meshId } : {}),
    replayed: true,
    note: `Already sent to ${existing.name} in this turn; it was not sent again.`,
  };
}

async function emitHubOutboundEcho(
  echo: ((outbound: HubOutboundEcho) => Promise<void>) | undefined,
  sent: Extract<HubSendResult, { ok: true }>,
) {
  if (!echo) return;
  await echo({
    block: hubOutboundEchoBlock({
      hubAgentId: sent.hubAgentId,
      name: sent.name,
      text: sent.text,
      intent: sent.intent,
    }),
    nonce: hubOutboundEchoNonce(sent.deliveryId),
  });
}

function isUniqueConstraint(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "P2002");
}
