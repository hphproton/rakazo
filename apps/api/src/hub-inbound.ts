import { ORPCError } from "@orpc/server";
import type { JobPublisher } from "@rakazo/adapter-kit";
import { runContinueJob } from "@rakazo/adapter-kit";
import type { Actor, BotMessageIntent } from "@rakazo/contracts";
import {
  ACTIVE_RUN_STATUSES,
  BOT_MESSAGE_MAX_LENGTH,
  buildHubMessageWakePrompt,
  hubInboundBlock,
  isConversationalRun,
} from "@rakazo/core";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { appendEventInTransaction, createThreadMessageInTransaction } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { withSerializableRetry } from "./serializable-retry.js";
import type { ThreadTarget } from "./thread-target.js";
import { cancelSupersededQueuedRuns } from "./thread-target.js";

const STEERABLE_RUN_STATUSES = new Set(["queued", "leased", "running", "waiting_takeover"]);
const RUNS_NEEDING_CONTINUE = new Set(["queued", "waiting_takeover"]);

function steersUserMessage(run: { status: string; trigger?: string | null }) {
  return STEERABLE_RUN_STATUSES.has(run.status) && isConversationalRun(run.trigger);
}

function isUniqueConstraintError(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "P2002");
}

type HubRun = { id: string; taskId: string; status: string };

/**
 * Land a Hub agent's text in a bot thread as a peer receipt and wake that bot.
 * No face bot has to call message_bot. The run trigger is `hub_message` so a
 * finished turn is not auto-returned through message_bot to an id that is not
 * a workspace bot.
 */
export async function receiveHubMessage(
  deps: {
    prisma: PrismaClient;
    events: Pick<ThreadEvents, "notify">;
    jobs: Pick<JobPublisher, "enqueue">;
  },
  actor: Actor,
  target: Extract<ThreadTarget, { kind: "bot" }>,
  input: {
    hubAgentId: string;
    hubAgentName: string;
    text: string;
    intent?: BotMessageIntent;
    clientNonce?: string;
    spaceTopicKey?: string;
  },
) {
  const hubAgentId = input.hubAgentId.trim();
  const hubAgentName = input.hubAgentName.trim();
  const text = input.text.trim();
  if (!hubAgentId || !hubAgentName || !text) {
    throw new ORPCError("BAD_REQUEST", { message: "Hub agent id, name, and text are required." });
  }
  if (text.length > BOT_MESSAGE_MAX_LENGTH) {
    throw new ORPCError("BAD_REQUEST", {
      message: `Message exceeds the ${BOT_MESSAGE_MAX_LENGTH} character limit.`,
    });
  }
  if (hubAgentId === target.botId) {
    throw new ORPCError("BAD_REQUEST", {
      message: "A bot cannot receive a Hub message as itself.",
    });
  }

  const replayed = await replayHubDelivery(deps, target.threadId, input.clientNonce);
  if (replayed) return replayed;

  const block = hubInboundBlock({
    fromBotId: hubAgentId,
    fromBotName: hubAgentName,
    text,
    intent: input.intent,
    spaceTopicKey: input.spaceTopicKey,
  });
  const prompt = buildHubMessageWakePrompt({
    from: { id: hubAgentId, name: hubAgentName },
    text,
    intent: input.intent,
  });

  const commit = () =>
    deps.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM threads WHERE id = ${target.threadId} FOR UPDATE`;
      if (input.clientNonce) {
        const already = await tx.message.findUnique({
          where: {
            threadId_clientNonce: { threadId: target.threadId, clientNonce: input.clientNonce },
          },
          select: { id: true },
        });
        if (already) return { replay: true as const };
      }

      const activeRuns = await tx.run.findMany({
        where: {
          threadId: target.threadId,
          botId: target.botId,
          status: { in: [...ACTIVE_RUN_STATUSES] },
        },
        select: { id: true, taskId: true, status: true, trigger: true },
      });
      const waitingRuns = activeRuns.filter((run) => run.status === "waiting_input");
      if (waitingRuns.length && !activeRuns.some(steersUserMessage)) {
        throw new ORPCError("CONFLICT", { message: "Answer the pending ask first." });
      }
      if (
        activeRuns.some(
          (run) => run.status !== "waiting_input" && !STEERABLE_RUN_STATUSES.has(run.status),
        )
      ) {
        throw new ORPCError("CONFLICT", { message: "Answer the pending ask first." });
      }

      const message = await createThreadMessageInTransaction(tx, {
        threadId: target.threadId,
        role: "user",
        blocks: [block],
        clientNonce: input.clientNonce,
        markUnread: true,
      });
      const active = activeRuns.find(steersUserMessage) ?? activeRuns[0];
      if (active) {
        await tx.steeringMessage.create({
          data: {
            messageId: message.id,
            botId: target.botId,
            userId: actor.userId,
            runId: steersUserMessage(active) ? active.id : null,
          },
        });
        await tx.message.update({ where: { id: message.id }, data: { runId: active.id } });
        const event = await appendEventInTransaction(tx, {
          spaceId: actor.spaceId,
          threadId: target.threadId,
          botId: target.botId,
          type: "thread.message.created",
          runId: active.id,
          payload: { messageId: message.id, role: "user", blocks: [block] },
        });
        return { message, runs: [active], eventSeq: event.seq };
      }

      const task = await tx.task.create({
        data: {
          spaceId: actor.spaceId,
          botId: target.botId,
          threadId: target.threadId,
          userId: actor.userId,
          prompt,
          status: "queued",
        },
      });
      const run = await tx.run.create({
        data: {
          spaceId: actor.spaceId,
          botId: target.botId,
          threadId: target.threadId,
          taskId: task.id,
          userId: actor.userId,
          status: "queued",
          trigger: "hub_message",
          clientNonce: input.clientNonce ? `hub:${message.id}` : undefined,
          sourceMessageId: message.id,
        },
      });
      await tx.message.update({ where: { id: message.id }, data: { runId: run.id } });
      await cancelSupersededQueuedRuns(tx, {
        threadId: target.threadId,
        botIds: [target.botId],
        keepRunIds: [run.id],
      });
      const event = await appendEventInTransaction(tx, {
        spaceId: actor.spaceId,
        threadId: target.threadId,
        botId: target.botId,
        type: "thread.message.created",
        runId: run.id,
        payload: { messageId: message.id, role: "user", blocks: [block] },
      });
      return { message, runs: [run], eventSeq: event.seq };
    });

  const committed = await withSerializableRetry(commit).catch(async (error) => {
    if (isUniqueConstraintError(error) || input.clientNonce) {
      const winner = await replayHubDelivery(deps, target.threadId, input.clientNonce);
      if (winner) return { replayed: winner } as const;
    }
    throw error;
  });
  if ("replay" in committed) {
    const winner = await replayHubDelivery(deps, target.threadId, input.clientNonce);
    if (winner) return winner;
    throw new ORPCError("CONFLICT", { message: "Hub message already delivered." });
  }
  if ("replayed" in committed) return committed.replayed;

  await deps.events.notify(target.threadId, committed.eventSeq).catch((error) => {
    getLogger().error("hub message realtime notification", error);
  });
  await Promise.all(
    committed.runs
      .filter((run) => RUNS_NEEDING_CONTINUE.has(run.status))
      .map((run) =>
        deps.jobs.enqueue(runContinueJob(run.id)).catch((error) => {
          getLogger().error("hub message enqueue", error);
        }),
      ),
  );
  const first = committed.runs[0];
  if (!first)
    throw new ORPCError("INTERNAL_SERVER_ERROR", { message: "Hub message did not start a run." });
  return {
    taskId: first.taskId,
    runId: first.id,
    seq: committed.message.seq,
    runIds: committed.runs.map((run) => run.id),
  };
}

async function replayHubDelivery(
  deps: {
    prisma: PrismaClient;
    events: Pick<ThreadEvents, "notify">;
    jobs: Pick<JobPublisher, "enqueue">;
  },
  threadId: string,
  clientNonce: string | undefined,
) {
  if (!clientNonce) return null;
  const message = await deps.prisma.message.findUnique({
    where: { threadId_clientNonce: { threadId, clientNonce } },
    include: { sourceRuns: { orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: 1 } },
  });
  if (!message) return null;
  const linked =
    message.sourceRuns[0] ??
    (message.runId ? await deps.prisma.run.findUnique({ where: { id: message.runId } }) : null);
  if (!linked) return null;
  const run = linked as HubRun;
  if (RUNS_NEEDING_CONTINUE.has(run.status)) {
    await deps.jobs.enqueue(runContinueJob(run.id)).catch((error) => {
      getLogger().error("hub message replay enqueue", error);
    });
  }
  const latestEvent = await deps.prisma.event.findFirst({
    where: { threadId },
    orderBy: { seq: "desc" },
    select: { seq: true },
  });
  if (latestEvent) {
    await deps.events.notify(threadId, latestEvent.seq).catch((error) => {
      getLogger().error("hub message realtime notification", error);
    });
  }
  return { taskId: run.taskId, runId: run.id, seq: message.seq, runIds: [run.id] };
}
