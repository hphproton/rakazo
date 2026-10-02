import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { builtinAgentTools, DELEGATION_TOOL_NAMES } from "./builtin-tools.js";
import { ackHubInbox, hubOutboundEchoNonce, listHubInbox, sendHubMessage } from "./hub-send.js";

const run = {
  id: "run-1",
  spaceId: "space-1",
  threadId: "thread-1",
  botId: "bot-chief",
  userId: "user-1",
};
const sender = { id: "bot-chief", name: "Chief" };

const principal = {
  name: "Box Principal",
  title: "Principal",
  archivedAt: null,
  spawnKey: "hub:f4adcc55-1111-4111-8111-111111111111",
};

function harness(
  options: {
    bots?: unknown[];
    running?: boolean;
    existing?: Record<string, unknown> | null;
    uniqueOnCreate?: boolean;
    messages?: unknown[];
    groupId?: string | null;
  } = {},
) {
  const create = vi.fn(async (args: { data: Record<string, unknown> }) => {
    if (options.uniqueOnCreate) {
      throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
    }
    return { id: "delivery-1", ...args.data, createdAt: new Date("2026-10-02T00:00:00.000Z") };
  });
  const messageCreate = vi.fn();
  const prisma = {
    bot: { findMany: vi.fn(async () => options.bots ?? [principal]) },
    thread: {
      findFirst: vi.fn(async () => ({ groupId: options.groupId ?? null })),
    },
    run: {
      findFirst: vi.fn(async () => (options.running === false ? null : { id: "run-1" })),
    },
    hubOutbound: {
      findFirst: vi.fn(async () => options.existing ?? null),
      findMany: vi.fn(async () => [] as unknown[]),
      create,
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    message: {
      create: messageCreate,
      findMany: vi.fn(async () => options.messages ?? []),
    },
  };
  return { prisma: prisma as unknown as PrismaClient, create, messageCreate, raw: prisma };
}

describe("hub_send_message registration", () => {
  it("registers the builtin and tells the model TO_HUB: does not send", () => {
    const tool = builtinAgentTools.find((entry) => entry.name === "hub_send_message");
    expect(tool?.description).toContain("TO_HUB:");
    expect(tool?.description.toLowerCase()).toContain("does not send");
    expect(tool?.inputSchema).toMatchObject({
      required: ["text"],
      properties: {
        target: expect.any(Object),
        hubAgentId: expect.any(Object),
        text: expect.any(Object),
        intent: expect.objectContaining({
          enum: ["request", "result", "question", "status", "fyi"],
        }),
      },
    });
    expect(builtinAgentTools.some((entry) => entry.name === "message_bot")).toBe(true);
    expect(DELEGATION_TOOL_NAMES.has("hub_send_message")).toBe(true);
    expect(DELEGATION_TOOL_NAMES.has("message_bot")).toBe(true);
    const names = builtinAgentTools.map((entry) => entry.name);
    expect(names.indexOf("hub_send_message")).toBe(names.indexOf("message_user") + 1);
    const messageBot = builtinAgentTools.find((entry) => entry.name === "message_bot");
    expect(messageBot?.description).toContain("hub_send_message");
    expect(messageBot?.description.toLowerCase()).toContain("not teammates");
  });
});

describe("sendHubMessage", () => {
  it("queues a HUB-INBOX row and echoes the payload for the sending thread", async () => {
    const { prisma, create, messageCreate } = harness();
    const echo = vi.fn();
    const sent = await sendHubMessage(
      prisma,
      run,
      sender,
      {
        hubAgentId: "F4ADCC55-1111-4111-8111-111111111111",
        text: "Ship the notes",
        deliveryKey: "effect-1",
      },
      echo,
    );
    expect(sent).toMatchObject({
      ok: true,
      hubAgentId: "f4adcc55-1111-4111-8111-111111111111",
      name: "Box Principal",
      deliveryId: "delivery-1",
      text: "Ship the notes",
      intent: "request",
    });
    expect(echo).toHaveBeenCalledWith({
      nonce: hubOutboundEchoNonce("delivery-1"),
      block: {
        kind: "hub_message_sent",
        hubAgentId: "f4adcc55-1111-4111-8111-111111111111",
        name: "Box Principal",
        text: "Ship the notes",
        intent: "request",
      },
    });
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]?.[0].data).toMatchObject({
      status: "wake",
      text: "Ship the notes",
      intent: "request",
      hubAgentId: "f4adcc55-1111-4111-8111-111111111111",
      idempotencyKey: "hub-send:space-1:user-1:effect-1",
      threadKey: null,
    });
    expect(messageCreate).not.toHaveBeenCalled();
  });

  it("copies the open topic key onto the echo and leaves threadKey on the outbox row", async () => {
    const { prisma, create } = harness({
      messages: [
        {
          id: "in-1",
          threadId: "thread-1",
          seq: 1,
          role: "user",
          createdAt: new Date("2026-10-02T10:00:00.000Z"),
          blocks: [
            {
              kind: "bot_message_received",
              fromBotId: "f4adcc55-1111-4111-8111-111111111111",
              fromBotName: "Box Principal",
              origin: "hub",
              text: "ping",
              spaceTopicKey: "burst-1",
            },
          ],
        },
      ],
    });
    const echo = vi.fn();
    await sendHubMessage(
      prisma,
      run,
      sender,
      {
        target: "Box Principal",
        text: "ack the burst",
        threadKey: "not-the-join-key",
      },
      echo,
    );
    expect(create.mock.calls[0]?.[0].data.threadKey).toBe("not-the-join-key");
    expect(echo).toHaveBeenCalledWith({
      nonce: hubOutboundEchoNonce("delivery-1"),
      block: {
        kind: "hub_message_sent",
        hubAgentId: "f4adcc55-1111-4111-8111-111111111111",
        name: "Box Principal",
        text: "ack the burst",
        intent: "request",
        spaceTopicKey: "burst-1",
      },
    });
  });

  it("does not invent a key from threadKey or a topic a person message already closed", async () => {
    const closed = harness({
      messages: [
        {
          id: "in-1",
          threadId: "thread-1",
          seq: 1,
          role: "user",
          createdAt: new Date("2026-10-02T10:00:00.000Z"),
          blocks: [
            {
              kind: "bot_message_received",
              fromBotId: "f4adcc55-1111-4111-8111-111111111111",
              fromBotName: "Box Principal",
              origin: "hub",
              text: "ping",
              spaceTopicKey: "burst-1",
            },
          ],
        },
        {
          id: "person",
          threadId: "thread-1",
          seq: 2,
          role: "user",
          createdAt: new Date("2026-10-02T10:05:00.000Z"),
          blocks: [{ kind: "text", text: "a different request" }],
        },
      ],
    });
    const echo = vi.fn();
    await sendHubMessage(
      closed.prisma,
      run,
      sender,
      { target: "Box Principal", text: "later", threadKey: "burst-1" },
      echo,
    );
    expect(echo.mock.calls[0]?.[0].block).not.toHaveProperty("spaceTopicKey");
    expect(closed.create.mock.calls[0]?.[0].data.threadKey).toBe("burst-1");
  });

  it("stores the ChatGroup id in threadKey when the caller omits it", async () => {
    const { prisma, create } = harness({ groupId: "cmurj44br000i139hmz577ken" });
    const echo = vi.fn();
    const sent = await sendHubMessage(
      prisma,
      run,
      sender,
      {
        target: "Box Principal",
        text: "From the group",
      },
      echo,
    );
    expect(sent).toMatchObject({ ok: true, deliveryId: "delivery-1" });
    expect(create.mock.calls[0]?.[0].data).toMatchObject({
      status: "wake",
      threadKey: "cmurj44br000i139hmz577ken",
      text: "From the group",
    });
    expect(echo.mock.calls[0]?.[0].block).not.toHaveProperty("spaceTopicKey");
    expect(echo.mock.calls[0]?.[0].block).not.toHaveProperty("threadKey");
  });

  it("keeps a caller-supplied threadKey on a group thread", async () => {
    const { prisma, create } = harness({ groupId: "cmurj44br000i139hmz577ken" });
    await sendHubMessage(prisma, run, sender, {
      target: "Box Principal",
      text: "From the group",
      threadKey: "follow-1",
    });
    expect(create.mock.calls[0]?.[0].data.threadKey).toBe("follow-1");
  });

  it("keeps the open topic key on the echo when threadKey is the group id", async () => {
    const { prisma, create } = harness({
      groupId: "cmurj44br000i139hmz577ken",
      messages: [
        {
          id: "in-1",
          threadId: "thread-1",
          seq: 1,
          role: "user",
          createdAt: new Date("2026-10-02T10:00:00.000Z"),
          blocks: [
            {
              kind: "bot_message_received",
              fromBotId: "f4adcc55-1111-4111-8111-111111111111",
              fromBotName: "Box Principal",
              origin: "hub",
              text: "ping",
              spaceTopicKey: "burst-1",
            },
          ],
        },
      ],
    });
    const echo = vi.fn();
    await sendHubMessage(
      prisma,
      run,
      sender,
      { target: "Box Principal", text: "from the group" },
      echo,
    );
    expect(create.mock.calls[0]?.[0].data.threadKey).toBe("cmurj44br000i139hmz577ken");
    expect(echo.mock.calls[0]?.[0].block).toMatchObject({
      kind: "hub_message_sent",
      spaceTopicKey: "burst-1",
    });
    expect(echo.mock.calls[0]?.[0].block).not.toHaveProperty("threadKey");
  });

  it("resolves a unique name", async () => {
    const { prisma, create } = harness();
    const sent = await sendHubMessage(prisma, run, sender, {
      target: "Box Principal",
      text: "Status please",
      intent: "question",
    });
    expect(sent).toMatchObject({ ok: true, name: "Box Principal" });
    expect(create.mock.calls[0]?.[0].data.intent).toBe("question");
  });

  it("does not deliver when the target is missing, unknown, or ambiguous", async () => {
    const missing = harness();
    expect(await sendHubMessage(missing.prisma, run, sender, { text: "hello" })).toEqual({
      ok: false,
      error: "target_required",
    });
    expect(missing.create).not.toHaveBeenCalled();

    const unknown = harness();
    const echo = vi.fn();
    expect(
      await sendHubMessage(
        unknown.prisma,
        run,
        sender,
        {
          target: "No Such Agent",
          text: "hello",
        },
        echo,
      ),
    ).toEqual({ ok: false, error: "not_found", target: "No Such Agent" });
    expect(unknown.create).not.toHaveBeenCalled();
    expect(echo).not.toHaveBeenCalled();

    const ambiguous = harness({
      bots: [
        principal,
        { name: "Box Principal", title: "Other", archivedAt: null, spawnKey: "hub:other" },
      ],
    });
    const result = await sendHubMessage(ambiguous.prisma, run, sender, {
      target: "Box Principal",
      text: "hello",
    });
    expect(result).toMatchObject({ ok: false, error: "ambiguous" });
    expect(ambiguous.create).not.toHaveBeenCalled();
    expect(ambiguous.messageCreate).not.toHaveBeenCalled();
  });

  it("name-resolves only active rows, and still delivers an explicit archived id", async () => {
    const archived = harness({
      bots: [{ ...principal, archivedAt: new Date("2026-10-01T00:00:00.000Z") }],
    });
    expect(
      await sendHubMessage(archived.prisma, run, sender, {
        target: "Box Principal",
        text: "hello",
      }),
    ).toEqual({ ok: false, error: "not_found", target: "Box Principal" });
    expect(archived.create).not.toHaveBeenCalled();

    const byId = await sendHubMessage(archived.prisma, run, sender, {
      hubAgentId: "f4adcc55-1111-4111-8111-111111111111",
      text: "still you",
    });
    expect(byId).toMatchObject({ ok: true, name: "Box Principal" });
    expect(archived.create).toHaveBeenCalledTimes(1);
  });

  it("does not deliver when the source run is no longer active", async () => {
    const { prisma, create } = harness({ running: false });
    expect(
      await sendHubMessage(prisma, run, sender, { target: "Box Principal", text: "hello" }),
    ).toEqual({ ok: false, error: "source_run_inactive" });
    expect(create).not.toHaveBeenCalled();
  });

  it("replays an idempotent delivery without a second row", async () => {
    const { prisma, create } = harness({
      existing: {
        id: "delivery-1",
        hubAgentId: "f4adcc55-1111-4111-8111-111111111111",
        name: "Box Principal",
        text: "Ship the notes",
        intent: "request",
        meshId: null,
      },
    });
    const echo = vi.fn();
    const sent = await sendHubMessage(
      prisma,
      run,
      sender,
      {
        target: "someone else",
        text: "",
        deliveryKey: "effect-1",
      },
      echo,
    );
    expect(sent).toMatchObject({
      ok: true,
      deliveryId: "delivery-1",
      replayed: true,
      text: "Ship the notes",
      hubAgentId: "f4adcc55-1111-4111-8111-111111111111",
    });
    expect(create).not.toHaveBeenCalled();
    expect(echo).toHaveBeenCalledWith(
      expect.objectContaining({
        nonce: "hub-outbound:delivery-1",
        block: expect.objectContaining({ text: "Ship the notes", name: "Box Principal" }),
      }),
    );
  });
});

describe("hub outbox drain", () => {
  it("lists wake rows for the caller and acks only that caller's ids", async () => {
    const createdAt = new Date("2026-10-02T03:04:05.000Z");
    const { prisma, raw } = harness();
    raw.hubOutbound.findMany.mockResolvedValue([
      {
        id: "delivery-1",
        spaceId: "space-1",
        userId: "user-1",
        botId: "bot-chief",
        fromBotName: "Chief",
        hubAgentId: "f4adcc55-1111-4111-8111-111111111111",
        name: "Box Principal",
        title: "Principal",
        text: "Ship the notes",
        intent: "request",
        threadKey: "follow-1",
        status: "wake",
        meshId: null,
        createdAt,
      },
    ]);
    const items = await listHubInbox(prisma, { spaceId: "space-1", userId: "user-1" });
    expect(items).toEqual([
      {
        kind: "HUB-INBOX",
        deliveryId: "delivery-1",
        status: "wake",
        hubAgentId: "f4adcc55-1111-4111-8111-111111111111",
        name: "Box Principal",
        title: "Principal",
        text: "Ship the notes",
        intent: "request",
        threadKey: "follow-1",
        fromBotId: "bot-chief",
        fromBotName: "Chief",
        spaceId: "space-1",
        createdAt: "2026-10-02T03:04:05.000Z",
      },
    ]);
    expect(raw.hubOutbound.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { spaceId: "space-1", userId: "user-1", status: "wake" },
      }),
    );

    const acked = await ackHubInbox(prisma, { spaceId: "space-1", userId: "user-1" }, [
      "delivery-1",
    ]);
    expect(acked).toBe(1);
    expect(raw.hubOutbound.updateMany).toHaveBeenCalledWith({
      where: {
        id: { in: ["delivery-1"] },
        spaceId: "space-1",
        userId: "user-1",
        status: "wake",
      },
      data: { status: "done" },
    });

    await ackHubInbox(prisma, { spaceId: "space-1", userId: "user-1" }, ["delivery-1"], "mesh-1");
    expect(raw.hubOutbound.updateMany).toHaveBeenLastCalledWith({
      where: {
        id: { in: ["delivery-1"] },
        spaceId: "space-1",
        userId: "user-1",
        status: "wake",
      },
      data: { status: "done", meshId: "mesh-1" },
    });
  });
});
