import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { deliverHubInbound } from "./hub-cutover.js";
import { receiveHubMessage } from "./hub-inbound.js";
import type { ThreadTarget } from "./thread-target.js";

const actor = { spaceId: "workspace-1", userId: "user-1" } as Actor;
const target = {
  kind: "bot",
  botId: "bot-1",
  threadId: "thread-1",
} as Extract<ThreadTarget, { kind: "bot" }>;

function deliveryInput(overrides: Record<string, unknown> = {}) {
  return {
    hubAgentId: "hub-atlas",
    hubAgentName: "Atlas",
    text: "Check the deploy.",
    clientNonce: "hub-nonce-1",
    ...overrides,
  };
}

function transactionClient(activeRuns: Array<Record<string, unknown>> = []) {
  const tx = {
    $queryRaw: vi.fn(),
    thread: {
      update: vi.fn(async ({ data }: { data: { nextMessageSeq?: unknown } }) =>
        data.nextMessageSeq ? { nextMessageSeq: 4 } : { nextEventSeq: 9 },
      ),
    },
    message: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({
        id: "msg-hub",
        seq: 3,
        threadId: "thread-1",
        role: "user",
      }),
      update: vi.fn(),
    },
    run: {
      findMany: vi.fn().mockResolvedValue(activeRuns),
      findUnique: vi.fn().mockResolvedValue({ status: "queued", startedAt: null }),
      create: vi.fn().mockResolvedValue({ id: "run-hub", taskId: "task-hub", status: "queued" }),
      updateMany: vi.fn(),
    },
    task: {
      create: vi.fn().mockResolvedValue({ id: "task-hub" }),
      updateMany: vi.fn(),
    },
    steeringMessage: { create: vi.fn() },
    event: { create: vi.fn().mockResolvedValue({ seq: 8, threadId: "thread-1" }) },
  };
  const prisma = {
    message: { findUnique: vi.fn().mockResolvedValue(null) },
    run: { findUnique: vi.fn() },
    event: { findFirst: vi.fn() },
    $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
  } as unknown as PrismaClient;
  return { tx, prisma };
}

function deps(prisma: PrismaClient) {
  const notify = vi.fn().mockResolvedValue(undefined);
  const enqueue = vi.fn().mockResolvedValue(undefined);
  return {
    deps: { prisma, events: { notify }, jobs: { enqueue } },
    notify,
    enqueue,
  };
}

describe("receiveHubMessage", () => {
  it("persists a Hub peer receipt and wakes the target bot", async () => {
    const { tx, prisma } = transactionClient();
    const { deps: deliveryDeps, notify, enqueue } = deps(prisma);

    const result = await receiveHubMessage(deliveryDeps, actor, target, deliveryInput());

    expect(result).toEqual({
      taskId: "task-hub",
      runId: "run-hub",
      seq: 3,
      runIds: ["run-hub"],
    });
    expect(tx.message.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          role: "user",
          blocks: [
            {
              kind: "bot_message_received",
              fromBotId: "hub-atlas",
              fromBotName: "Atlas",
              text: "Check the deploy.",
              origin: "hub",
              intent: "request",
            },
          ],
        }),
      }),
    );
    expect(tx.thread.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ unread: true }),
      }),
    );
    expect(tx.run.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          trigger: "hub_message",
          sourceMessageId: "msg-hub",
          status: "queued",
        }),
      }),
    );
    const prompt = tx.task.create.mock.calls[0]?.[0].data.prompt as string;
    expect(prompt).toContain("not the user typing");
    expect(prompt).toContain("Hub agent");
    expect(prompt).toContain("Hub chip already records");
    expect(prompt).toContain('"OK."');
    expect(prompt).not.toContain("Your written reply in this thread is the response");
    expect(prompt).not.toContain("message_bot with bot_id");
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ name: "run.continue", payload: { runId: "run-hub" } }),
    );
    expect(notify).toHaveBeenCalledWith("thread-1", 8);
  });

  it("stores a space topic key on the Hub receipt and ignores a blank one", async () => {
    const keyed = transactionClient();
    await receiveHubMessage(deps(keyed.prisma).deps, actor, target, {
      ...deliveryInput(),
      spaceTopicKey: " burst-1 ",
    });
    expect(keyed.tx.message.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          blocks: [expect.objectContaining({ origin: "hub", spaceTopicKey: "burst-1" })],
        }),
      }),
    );

    const blank = transactionClient();
    await receiveHubMessage(deps(blank.prisma).deps, actor, target, {
      ...deliveryInput({ clientNonce: "hub-nonce-2" }),
      spaceTopicKey: "   ",
    });
    const blocks = blank.tx.message.create.mock.calls[0]?.[0].data.blocks as Array<
      Record<string, unknown>
    >;
    expect(blocks[0]).not.toHaveProperty("spaceTopicKey");
  });

  it("replays a delivery with the same client nonce", async () => {
    const { prisma } = transactionClient();
    prisma.message.findUnique = vi.fn().mockResolvedValue({
      id: "msg-hub",
      seq: 3,
      runId: "run-hub",
      sourceRuns: [{ id: "run-hub", taskId: "task-hub", status: "queued" }],
    }) as unknown as typeof prisma.message.findUnique;
    const { deps: deliveryDeps, enqueue } = deps(prisma);

    const result = await receiveHubMessage(deliveryDeps, actor, target, deliveryInput());

    expect(result).toMatchObject({ runId: "run-hub", taskId: "task-hub", seq: 3 });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledOnce();
  });

  it("does not answer a pending ask", async () => {
    const { tx, prisma } = transactionClient([
      { id: "run-ask", taskId: "task-ask", status: "waiting_input", trigger: "user" },
    ]);
    const { deps: deliveryDeps } = deps(prisma);

    await expect(
      receiveHubMessage(deliveryDeps, actor, target, deliveryInput()),
    ).rejects.toMatchObject({ code: "CONFLICT", message: "Answer the pending ask first." });
    expect(tx.message.create).not.toHaveBeenCalled();
    expect(tx.run.create).not.toHaveBeenCalled();
  });

  it("steers a live conversational run instead of starting another", async () => {
    const { tx, prisma } = transactionClient([
      { id: "run-live", taskId: "task-live", status: "running", trigger: "user" },
    ]);
    const { deps: deliveryDeps, enqueue } = deps(prisma);

    const result = await receiveHubMessage(deliveryDeps, actor, target, deliveryInput());

    expect(result.runId).toBe("run-live");
    expect(tx.run.create).not.toHaveBeenCalled();
    expect(tx.steeringMessage.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ messageId: "msg-hub", runId: "run-live" }),
      }),
    );
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("waits out a creation intro instead of overlapping it", async () => {
    const { tx, prisma } = transactionClient([
      { id: "run-intro", taskId: "task-intro", status: "running", trigger: "created" },
    ]);
    const { deps: deliveryDeps, enqueue } = deps(prisma);

    await receiveHubMessage(deliveryDeps, actor, target, deliveryInput());

    expect(tx.run.create).not.toHaveBeenCalled();
    expect(tx.steeringMessage.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ runId: null }),
      }),
    );
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("delivers through the preferred receiveHub path", async () => {
    const { tx, prisma } = transactionClient();
    const { deps: deliveryDeps } = deps(prisma);

    await deliverHubInbound(deliveryDeps, actor, target, deliveryInput());

    expect(tx.run.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ trigger: "hub_message" }),
      }),
    );
    expect(tx.message.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          blocks: [expect.objectContaining({ origin: "hub", fromBotId: "hub-atlas" })],
        }),
      }),
    );
  });

  it("rejects a Hub id that is the target bot", async () => {
    const { prisma } = transactionClient();
    const { deps: deliveryDeps } = deps(prisma);

    await expect(
      receiveHubMessage(deliveryDeps, actor, target, deliveryInput({ hubAgentId: "bot-1" })),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
