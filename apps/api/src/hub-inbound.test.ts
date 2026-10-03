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
const groupTarget = {
  kind: "group",
  groupId: "group-1",
  threadId: "thread-g",
  groupName: "Team B",
  members: [],
  memberBotIds: ["bot-chief", "bot-deputy"],
} as Extract<ThreadTarget, { kind: "group" }>;

const groupMembers = [
  { bot: { id: "bot-chief", name: "Chief" } },
  { bot: { id: "bot-deputy", name: "Deputy" } },
];

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

function groupTransaction(activeRuns: Array<Record<string, unknown>> = []) {
  let created = 0;
  let messages = 0;
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([{ id: "group-1" }]),
    chatGroup: {
      findFirst: vi.fn().mockResolvedValue({
        id: "group-1",
        members: groupMembers,
      }),
      update: vi.fn(),
    },
    thread: {
      update: vi.fn(async ({ data }: { data: { nextMessageSeq?: unknown } }) =>
        data.nextMessageSeq ? { nextMessageSeq: 4 } : { nextEventSeq: 9 },
      ),
    },
    message: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn(async () => {
        messages += 1;
        return {
          id: `msg-hub-${messages}`,
          seq: 3,
          threadId: "thread-g",
          role: "user",
        };
      }),
      update: vi.fn(),
    },
    run: {
      findMany: vi.fn().mockResolvedValue(activeRuns),
      findUnique: vi.fn().mockResolvedValue({ status: "queued", startedAt: null }),
      create: vi.fn(async (args: { data: { botId: string } }) => {
        created += 1;
        return {
          id: `run-${created}`,
          taskId: `task-${created}`,
          status: "queued",
          botId: args.data.botId,
        };
      }),
      updateMany: vi.fn(),
    },
    task: {
      create: vi.fn(async () => ({ id: `task-${created + 1}` })),
      updateMany: vi.fn(),
    },
    steeringMessage: { create: vi.fn() },
    event: { create: vi.fn().mockResolvedValue({ seq: 8, threadId: "thread-g" }) },
  };
  const prisma = {
    message: { findUnique: vi.fn().mockResolvedValue(null) },
    run: { findUnique: vi.fn() },
    event: { findFirst: vi.fn() },
    chatGroup: {
      findFirst: vi.fn().mockResolvedValue({
        id: "group-1",
        members: groupMembers,
      }),
    },
    thread: {
      findMany: vi.fn().mockResolvedValue([
        { id: "thread-chief", botId: "bot-chief" },
        { id: "thread-deputy", botId: "bot-deputy" },
      ]),
    },
    $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
  } as unknown as PrismaClient;
  return { tx, prisma };
}

function messageThreadIds(tx: {
  message: { create: { mock: { calls: Array<[{ data: { threadId: string } }]> } } };
}): string[] {
  return tx.message.create.mock.calls.map((call) => call[0].data.threadId);
}

function hubReceipts(tx: {
  message: {
    create: { mock: { calls: Array<[{ data: { blocks: Array<Record<string, unknown>> } }]> } };
  };
}): Array<Record<string, unknown>> {
  return tx.message.create.mock.calls.flatMap((call) => call[0].data.blocks);
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

  it("stores a space topic key on the group receipt and ignores a blank one", async () => {
    const keyed = groupTransaction();
    await deliverHubInbound(deps(keyed.prisma).deps, actor, groupTarget, {
      ...deliveryInput(),
      spaceTopicKey: " burst-1 ",
    });
    expect(keyed.tx.message.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          threadId: "thread-g",
          blocks: [expect.objectContaining({ origin: "hub", spaceTopicKey: "burst-1" })],
        }),
      }),
    );

    const blank = groupTransaction();
    await receiveHubMessage(deps(blank.prisma).deps, actor, groupTarget, {
      ...deliveryInput({ clientNonce: "hub-nonce-2" }),
      spaceTopicKey: "   ",
    });
    const blocks = blank.tx.message.create.mock.calls[0]?.[0].data.blocks as Array<
      Record<string, unknown>
    >;
    expect(blocks[0]).not.toHaveProperty("spaceTopicKey");

    const tooLong = groupTransaction();
    await receiveHubMessage(deps(tooLong.prisma).deps, actor, groupTarget, {
      ...deliveryInput({ clientNonce: "hub-nonce-3" }),
      spaceTopicKey: "a".repeat(201),
    });
    const longBlocks = tooLong.tx.message.create.mock.calls[0]?.[0].data.blocks as Array<
      Record<string, unknown>
    >;
    expect(longBlocks[0]).not.toHaveProperty("spaceTopicKey");
  });

  it("lands a Hub receipt on the group thread and wakes the first member", async () => {
    const { tx, prisma } = groupTransaction();
    const { deps: deliveryDeps, notify, enqueue } = deps(prisma);

    const result = await receiveHubMessage(deliveryDeps, actor, groupTarget, deliveryInput());

    expect(result).toEqual({
      taskId: "task-1",
      runId: "run-1",
      seq: 3,
      runIds: ["run-1"],
    });
    expect(tx.message.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          threadId: "thread-g",
          blocks: [expect.objectContaining({ origin: "hub", fromBotId: "hub-atlas" })],
        }),
      }),
    );
    expect(tx.run.create).toHaveBeenCalledTimes(1);
    expect(tx.run.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          botId: "bot-chief",
          threadId: "thread-g",
          trigger: "hub_message",
          clientNonce: "hub:msg-hub-1:bot-chief",
        }),
      }),
    );
    expect(tx.chatGroup.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "group-1" } }),
    );
    expect(notify).toHaveBeenCalledWith("thread-g", 8);
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ name: "run.continue", payload: { runId: "run-1" } }),
    );
  });

  it("wakes only the named group member", async () => {
    const { tx, prisma } = groupTransaction();
    const { deps: deliveryDeps } = deps(prisma);

    await receiveHubMessage(
      deliveryDeps,
      actor,
      groupTarget,
      deliveryInput({ text: "@Deputy check the deploy" }),
    );

    expect(tx.run.create).toHaveBeenCalledTimes(1);
    expect(tx.run.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ botId: "bot-deputy" }),
      }),
    );
  });

  it("splits a Hub message to Chief and Deputy onto each bot thread", async () => {
    const everyone = groupTransaction();
    const everyoneDeps = deps(everyone.prisma);
    const everyoneResult = await receiveHubMessage(
      everyoneDeps.deps,
      actor,
      groupTarget,
      deliveryInput({ text: "@everyone check the deploy", spaceTopicKey: "burst-1" }),
    );

    expect(everyoneResult.runIds).toEqual(["run-1", "run-2"]);
    expect(messageThreadIds(everyone.tx)).toEqual(["thread-chief", "thread-deputy"]);
    expect(messageThreadIds(everyone.tx)).not.toContain("thread-g");
    expect(hubReceipts(everyone.tx).every((block) => block.spaceTopicKey === "burst-1")).toBe(true);
    expect(everyone.tx.chatGroup.update).not.toHaveBeenCalled();
    expect(everyoneDeps.enqueue).toHaveBeenCalledTimes(2);

    const named = groupTransaction();
    const namedResult = await receiveHubMessage(
      deps(named.prisma).deps,
      actor,
      groupTarget,
      deliveryInput({
        text: "@Chief @Deputy check the deploy",
        clientNonce: "hub-nonce-2",
      }),
    );
    expect(namedResult.runIds).toHaveLength(2);
    expect(messageThreadIds(named.tx)).toEqual(["thread-chief", "thread-deputy"]);
    const nonces = named.tx.run.create.mock.calls.map((call) => call[0].data.clientNonce as string);
    expect(new Set(nonces).size).toBe(2);
  });

  it("does not answer a pending ask on the group thread", async () => {
    const { tx, prisma } = groupTransaction([
      {
        id: "run-ask",
        taskId: "task-ask",
        botId: "bot-chief",
        status: "waiting_input",
        trigger: "user",
      },
    ]);
    const { deps: deliveryDeps } = deps(prisma);

    await expect(
      receiveHubMessage(deliveryDeps, actor, groupTarget, deliveryInput()),
    ).rejects.toMatchObject({ code: "CONFLICT", message: "Answer the pending ask first." });
    expect(tx.message.create).not.toHaveBeenCalled();
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
