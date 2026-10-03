import type { Actor } from "@rakazo/contracts";
import { HubDirectorySchema, HubSyncResultSchema } from "@rakazo/contracts";
import type {
  HubDirectory,
  HubDirectoryGroupSource,
  HubMemberDraft,
  HubRosterRecord,
} from "@rakazo/core";
import {
  buildHubDirectory,
  HUB_SECTION_NAME,
  HubRosterError,
  hubRosterColor,
  planHubRosterSync,
} from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { type createRepos, IsolationError } from "@rakazo/db";
import { withHubDirectorySignature } from "./hub-sign.js";

type RosterRepos = Pick<ReturnType<typeof createRepos>, "createBot">;

export type HubRosterStore = {
  spaceId: string;
  list(): Promise<HubRosterRecord[]>;
  ensureHubSection(): Promise<string>;
  createHubBot(input: {
    spawnKey: string;
    name: string;
    title: string;
    sectionId: string;
    color: string;
  }): Promise<void>;
  updateHubBot(input: {
    botId: string;
    name: string;
    title: string;
    sectionId: string;
    unarchive: boolean;
  }): Promise<void>;
  archiveHubBot(botId: string, at: Date): Promise<void>;
  /** Absent on stores that predate group export. Those reads report no groups. */
  listGroups?(): Promise<HubDirectoryGroupSource[]>;
};

/**
 * Mirror Hub members onto Bot rows in the Hub section.
 * Does not write ExternalConversation rows and does not start an intro run.
 */
export async function syncHubMembers(
  store: HubRosterStore,
  members: readonly HubMemberDraft[],
  options: { issuedAt: Date; signingKey?: string },
): Promise<ReturnType<typeof HubSyncResultSchema.parse>> {
  const sectionId = await store.ensureHubSection();
  const existing = await store.list();
  const plan = planHubRosterSync(existing, members, sectionId);
  for (const member of plan.create) {
    await store.createHubBot({
      spawnKey: member.spawnKey,
      name: member.name,
      title: member.title,
      sectionId,
      color: hubRosterColor(member.hubAgentId),
    });
  }
  for (const member of plan.update) {
    await store.updateHubBot({
      botId: member.botId,
      name: member.name,
      title: member.title,
      sectionId,
      unarchive: member.unarchive,
    });
  }
  for (const member of plan.archive) {
    await store.archiveHubBot(member.botId, options.issuedAt);
  }
  const directory = signedDirectory(
    store.spaceId,
    await store.list(),
    options,
    await listDirectoryGroups(store),
  );
  return HubSyncResultSchema.parse({
    sectionId,
    sectionName: HUB_SECTION_NAME,
    created: plan.create.length,
    updated: plan.update.length,
    archived: plan.archive.length,
    directory,
  });
}

export async function readHubDirectory(
  store: Pick<HubRosterStore, "spaceId" | "list"> & Partial<Pick<HubRosterStore, "listGroups">>,
  options: { issuedAt: Date; signingKey?: string },
) {
  return signedDirectory(
    store.spaceId,
    await store.list(),
    options,
    await listDirectoryGroups(store),
  );
}

export function hubRosterStore(
  prisma: PrismaClient,
  repos: RosterRepos,
  actor: Actor,
): HubRosterStore {
  return {
    spaceId: actor.spaceId,
    async list() {
      const bots = await prisma.bot.findMany({
        where: { spaceId: actor.spaceId, userId: actor.userId },
        select: {
          id: true,
          name: true,
          title: true,
          archivedAt: true,
          spawnKey: true,
          sectionId: true,
          updatedAt: true,
        },
      });
      return bots.map((bot) => ({
        id: bot.id,
        name: bot.name,
        title: bot.title,
        archived: bot.archivedAt !== null,
        spawnKey: bot.spawnKey,
        sectionId: bot.sectionId,
        updatedAt: bot.updatedAt.toISOString(),
      }));
    },
    async ensureHubSection() {
      const where = {
        spaceId_userId_name: {
          spaceId: actor.spaceId,
          userId: actor.userId,
          name: HUB_SECTION_NAME,
        },
      };
      const existing = await prisma.botSection.findUnique({ where });
      if (existing) return existing.id;
      const aggregate = await prisma.botSection.aggregate({
        where: { spaceId: actor.spaceId, userId: actor.userId },
        _max: { position: true },
      });
      try {
        const created = await prisma.botSection.create({
          data: {
            spaceId: actor.spaceId,
            userId: actor.userId,
            name: HUB_SECTION_NAME,
            position: (aggregate._max.position ?? -1) + 1,
          },
        });
        return created.id;
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        const winner = await prisma.botSection.findUnique({ where });
        if (!winner) throw error;
        return winner.id;
      }
    },
    async createHubBot(input) {
      // No intro run: a mirrored member is a roster row, not a new local worker.
      const bot = await repos.createBot(actor, {
        name: input.name,
        title: input.title,
        description: "",
        instructions: "",
        notifyOnFinish: false,
        color: input.color,
        spawnKey: input.spawnKey,
        computerMode: "team",
      });
      await updateOwnedBot(prisma, actor, bot.id, {
        name: input.name,
        title: input.title,
        sectionId: input.sectionId,
        archivedAt: null,
      });
    },
    async updateHubBot(input) {
      await updateOwnedBot(prisma, actor, input.botId, {
        name: input.name,
        title: input.title,
        sectionId: input.sectionId,
        ...(input.unarchive ? { archivedAt: null } : {}),
      });
    },
    async archiveHubBot(botId, at) {
      await updateOwnedBot(prisma, actor, botId, { archivedAt: at, pinned: false });
    },
    async listGroups() {
      const groups = await prisma.chatGroup.findMany({
        where: { spaceId: actor.spaceId, userId: actor.userId, archivedAt: null },
        select: {
          id: true,
          name: true,
          members: { select: { botId: true } },
        },
      });
      return groups.map((group) => ({
        id: group.id,
        name: group.name,
        archived: false,
        memberBotIds: group.members.map((member) => member.botId),
      }));
    },
  };
}

async function listDirectoryGroups(
  store: Partial<Pick<HubRosterStore, "listGroups">>,
): Promise<HubDirectoryGroupSource[]> {
  return store.listGroups ? store.listGroups() : [];
}

function signedDirectory(
  spaceId: string,
  bots: readonly HubRosterRecord[],
  options: { issuedAt: Date; signingKey?: string },
  groups: readonly HubDirectoryGroupSource[],
) {
  const directory: HubDirectory = buildHubDirectory({
    spaceId,
    bots,
    groups,
    issuedAt: options.issuedAt.toISOString(),
  });
  return HubDirectorySchema.parse(withHubDirectorySignature(directory, options.signingKey));
}

async function updateOwnedBot(
  prisma: PrismaClient,
  actor: Actor,
  botId: string,
  data: {
    name?: string;
    title?: string;
    sectionId?: string;
    archivedAt?: Date | null;
    pinned?: boolean;
  },
) {
  const updated = await prisma.bot.updateMany({
    where: { id: botId, spaceId: actor.spaceId, userId: actor.userId },
    data,
  });
  if (updated.count !== 1) throw new IsolationError();
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "P2002");
}

export { HubRosterError };
