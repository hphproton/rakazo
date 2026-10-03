import { RPCHandler } from "@orpc/server/fetch";
import type { Actor } from "@rakazo/contracts";
import type { HubRosterRecord } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import {
  type HubRosterStore,
  hubRosterStore,
  readHubDirectory,
  syncHubMembers,
} from "./hub-roster.js";
import { verifyHubDirectorySignature } from "./hub-sign.js";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const actor = {
  spaceId: "space-1",
  userId: "user-1",
  email: "user@rakazo.test",
  isDeploymentOwner: true,
} satisfies Actor;

const issuedAt = new Date("2026-10-02T00:00:00.000Z");

function memoryStore(initial: HubRosterRecord[]) {
  const bots = initial.map((bot) => ({ ...bot }));
  let sectionId: string | null = null;
  let sequence = bots.length;
  const store: HubRosterStore = {
    spaceId: actor.spaceId,
    async list() {
      return bots.map((bot) => ({ ...bot }));
    },
    async ensureHubSection() {
      sectionId ??= "section-hub";
      return sectionId;
    },
    async createHubBot(input) {
      sequence += 1;
      bots.push({
        id: `created-${sequence}`,
        name: input.name,
        title: input.title,
        archived: false,
        spawnKey: input.spawnKey,
        sectionId: input.sectionId,
        updatedAt: `2026-10-02T00:00:0${sequence}.000Z`,
      });
    },
    async updateHubBot(input) {
      const bot = bots.find((item) => item.id === input.botId);
      if (!bot) throw new Error(`missing ${input.botId}`);
      bot.name = input.name;
      bot.title = input.title;
      bot.sectionId = input.sectionId;
      if (input.unarchive) bot.archived = false;
      bot.updatedAt = "2026-10-02T00:00:09.000Z";
    },
    async archiveHubBot(botId) {
      const bot = bots.find((item) => item.id === botId);
      if (!bot) throw new Error(`missing ${botId}`);
      bot.archived = true;
      bot.updatedAt = "2026-10-02T00:00:08.000Z";
    },
  };
  return store;
}

describe("syncHubMembers", () => {
  it("mirrors members onto Hub rows and exports a signed directory", async () => {
    const store = memoryStore([
      {
        id: "chief",
        name: "Chief",
        title: "",
        archived: false,
        spawnKey: "onboarding:first",
        sectionId: null,
        updatedAt: "2026-10-01T00:00:00.000Z",
      },
    ]);
    const signingKey = "test-directory-key";
    const synced = await syncHubMembers(
      store,
      [{ hubAgentId: "hub-atlas", name: "Atlas", title: "Deploy" }],
      { issuedAt, signingKey },
    );

    expect(synced.sectionName).toBe("Hub");
    expect(synced.created).toBe(1);
    expect(synced.updated).toBe(0);
    expect(synced.archived).toBe(0);
    expect(synced.directory.hubMembers).toEqual([
      {
        hubAgentId: "hub-atlas",
        botId: "created-2",
        name: "Atlas",
        title: "Deploy",
        archived: false,
      },
    ]);
    expect(synced.directory.rakazoBots.map((bot) => bot.id)).toEqual(["chief"]);
    expect(synced.directory.signature).toMatch(/^[0-9a-f]{64}$/);
    expect(
      verifyHubDirectorySignature(synced.directory, signingKey, synced.directory.signature ?? ""),
    ).toBe(true);
    expect(
      verifyHubDirectorySignature(synced.directory, "other-key", synced.directory.signature ?? ""),
    ).toBe(false);

    const again = await syncHubMembers(
      store,
      [{ hubAgentId: "hub-atlas", name: "Atlas", title: "Deploy" }],
      { issuedAt: new Date("2026-10-02T01:00:00.000Z"), signingKey },
    );
    expect(again.created).toBe(0);
    expect(again.updated).toBe(0);
    expect(again.archived).toBe(0);
    expect(again.directory.epoch).toBe(synced.directory.epoch);
    expect(again.directory.signature).toBe(synced.directory.signature);
    expect(again.directory.issuedAt).not.toBe(synced.directory.issuedAt);
  });

  it("archives omitted Hub members and does not archive workspace bots", async () => {
    const store = memoryStore([
      {
        id: "chief",
        name: "Chief",
        title: "",
        archived: false,
        spawnKey: null,
        sectionId: null,
        updatedAt: "2026-10-01T00:00:00.000Z",
      },
      {
        id: "atlas",
        name: "Atlas",
        title: "",
        archived: false,
        spawnKey: "hub:hub-atlas",
        sectionId: "section-hub",
        updatedAt: "2026-10-01T00:00:00.000Z",
      },
    ]);
    const synced = await syncHubMembers(store, [], { issuedAt });
    expect(synced.archived).toBe(1);
    expect(synced.directory.signature).toBeNull();
    expect(synced.directory.hubMembers).toEqual([
      {
        hubAgentId: "hub-atlas",
        botId: "atlas",
        name: "Atlas",
        title: "",
        archived: true,
      },
    ]);
    expect(synced.directory.rakazoBots).toEqual([
      {
        id: "chief",
        name: "Chief",
        title: "",
        archived: false,
        spawnKey: null,
      },
    ]);
  });

  it("keeps the bot id when a member returns", async () => {
    const store = memoryStore([
      {
        id: "atlas",
        name: "Atlas",
        title: "",
        archived: true,
        spawnKey: "hub:hub-atlas",
        sectionId: null,
        updatedAt: "2026-10-01T00:00:00.000Z",
      },
    ]);
    const synced = await syncHubMembers(store, [{ hubAgentId: "hub-atlas", name: "Atlas" }], {
      issuedAt,
    });
    expect(synced.created).toBe(0);
    expect(synced.updated).toBe(1);
    expect(synced.directory.hubMembers[0]).toMatchObject({ botId: "atlas", archived: false });
  });
});

describe("hubRosterStore", () => {
  it("lists the caller's bots and creates the Hub section without a messaging provider", async () => {
    const findMany = vi.fn().mockResolvedValue([
      {
        id: "chief",
        name: "Chief",
        title: "",
        archivedAt: null,
        spawnKey: "onboarding:first",
        sectionId: null,
        updatedAt: new Date("2026-10-01T00:00:00.000Z"),
      },
    ]);
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const create = vi.fn().mockResolvedValue({ id: "section-hub" });
    const prisma = {
      bot: { findMany, updateMany },
      botSection: {
        findUnique: vi.fn().mockResolvedValue(null),
        aggregate: vi.fn().mockResolvedValue({ _max: { position: 1 } }),
        create,
      },
    } as unknown as PrismaClient;
    const createBot = vi
      .fn()
      .mockResolvedValue({ id: "created", updatedAt: issuedAt.toISOString() });
    const store = hubRosterStore(prisma, { createBot }, actor);

    expect(await store.ensureHubSection()).toBe("section-hub");
    expect(create).toHaveBeenCalledWith({
      data: {
        spaceId: "space-1",
        userId: "user-1",
        name: "Hub",
        position: 2,
      },
    });
    expect(prisma).not.toHaveProperty("externalConversation");

    const listed = await store.list();
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { spaceId: "space-1", userId: "user-1" },
      }),
    );
    expect(listed).toEqual([
      {
        id: "chief",
        name: "Chief",
        title: "",
        archived: false,
        spawnKey: "onboarding:first",
        sectionId: null,
        updatedAt: "2026-10-01T00:00:00.000Z",
      },
    ]);

    await store.createHubBot({
      spawnKey: "hub:hub-atlas",
      name: "Atlas",
      title: "Deploy",
      sectionId: "section-hub",
      color: "#3EC5A8",
    });
    expect(createBot).toHaveBeenCalledWith(
      actor,
      expect.objectContaining({
        name: "Atlas",
        spawnKey: "hub:hub-atlas",
        notifyOnFinish: false,
        computerMode: "team",
      }),
    );
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "created", spaceId: "space-1", userId: "user-1" },
      data: {
        name: "Atlas",
        title: "Deploy",
        sectionId: "section-hub",
        archivedAt: null,
      },
    });
  });

  it("reads non-archived chat groups for the directory and does not open a messaging provider", async () => {
    const findMany = vi.fn().mockResolvedValue([
      {
        id: "group-b",
        name: "Team B",
        members: [{ botId: "chief" }, { botId: "deputy" }],
      },
    ]);
    const prisma = {
      chatGroup: { findMany },
    } as unknown as PrismaClient;
    const store = hubRosterStore(prisma, { createBot: vi.fn() }, actor);
    expect(await store.listGroups?.()).toEqual([
      {
        id: "group-b",
        name: "Team B",
        archived: false,
        memberBotIds: ["chief", "deputy"],
      },
    ]);
    expect(findMany).toHaveBeenCalledWith({
      where: { spaceId: "space-1", userId: "user-1", archivedAt: null },
      select: {
        id: true,
        name: true,
        members: { select: { botId: true } },
      },
    });
    expect(prisma).not.toHaveProperty("externalConversation");
  });
});

describe("readHubDirectory", () => {
  it("requires no write and omits a signature when no key is configured", async () => {
    const store = memoryStore([
      {
        id: "chief",
        name: "Chief",
        title: "Lead",
        archived: false,
        spawnKey: null,
        sectionId: null,
        updatedAt: "2026-10-01T00:00:00.000Z",
      },
    ]);
    const directory = await readHubDirectory(store, { issuedAt });
    expect(directory.signature).toBeNull();
    expect(directory.rakazoBots).toEqual([
      { id: "chief", name: "Chief", title: "Lead", archived: false, spawnKey: null },
    ]);
    expect(directory.hubMembers).toEqual([]);
    expect(directory.groups).toEqual([]);
  });

  it("exports workspace group members and leaves Hub rows out of the member list", async () => {
    const store = memoryStore([
      {
        id: "chief",
        name: "Chief",
        title: "",
        archived: false,
        spawnKey: null,
        sectionId: null,
        updatedAt: "2026-10-01T00:00:00.000Z",
      },
      {
        id: "deputy",
        name: "Deputy",
        title: "",
        archived: true,
        spawnKey: null,
        sectionId: null,
        updatedAt: "2026-10-01T00:00:00.000Z",
      },
      {
        id: "atlas",
        name: "Atlas",
        title: "",
        archived: false,
        spawnKey: "hub:hub-atlas",
        sectionId: "section-hub",
        updatedAt: "2026-10-01T00:00:00.000Z",
      },
    ]);
    store.listGroups = async () => [
      {
        id: "group-b",
        name: "Team B",
        archived: false,
        memberBotIds: ["atlas", "deputy", "chief"],
      },
    ];
    const directory = await readHubDirectory(store, { issuedAt, signingKey: "test-directory-key" });
    expect(directory.groups).toEqual([{ id: "group-b", name: "Team B", memberBotIds: ["chief"] }]);
    expect(directory.hubMembers.map((member) => member.hubAgentId)).toEqual(["hub-atlas"]);
    const joined = await readHubDirectory(
      {
        ...store,
        async list() {
          const bots = await store.list();
          return bots.map((bot) => (bot.id === "deputy" ? { ...bot, archived: false } : bot));
        },
      },
      { issuedAt, signingKey: "test-directory-key" },
    );
    expect(joined.groups[0]?.memberBotIds).toEqual(["chief", "deputy"]);
    expect(joined.epoch).not.toBe(directory.epoch);
    expect(joined.signature).not.toBe(directory.signature);
  });
});

describe("hub roster routes", () => {
  it("rejects an unauthenticated directory read", async () => {
    const deps = {
      prisma: {},
      env: {
        agentRuntime: "scripted",
        defaultProvider: "fake",
        defaultModel: "fake-model",
        webOrigin: "http://127.0.0.1:5173",
        screenProxySecret: "fake-test-secret",
        sandboxProvider: "fake",
      },
      dataDir: "/tmp/rakazo-hub-roster-test",
    } as unknown as RouterDeps;
    const handler = new RPCHandler(createRouter(deps));
    const { response } = await handler.handle(
      new Request("http://127.0.0.1/rpc/hub/directory", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: {} }),
      }),
      { prefix: "/rpc", context: { actor: null } },
    );
    expect(response.status).toBe(401);
  });
});
