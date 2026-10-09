import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@rakazo/db";
import { createDb } from "@rakazo/db";
import { afterAll, describe, expect, it } from "vitest";
import type { TeamDesktopHost } from "./team-desktop.js";
import { createPrismaTeamDesktopStore, createTeamDesktopAllocator } from "./team-desktop.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

describePostgres("team desktop wake (migrated PostgreSQL)", () => {
  let prisma: PrismaClient;
  let close: () => Promise<void>;
  const organizationIds: string[] = [];
  const userIds: string[] = [];

  afterAll(async () => {
    if (!prisma) return;
    await prisma.organization.deleteMany({ where: { id: { in: organizationIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await close();
  });

  it("wakes a stopped team desktop through booting to running", async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    close = async () => {
      await db.prisma.$disconnect();
      await db.pool.end();
    };

    const id = randomUUID();
    organizationIds.push(id);
    userIds.push(id);
    const createdAt = new Date();
    await prisma.user.create({
      data: {
        id,
        name: "Desktop wake",
        email: `${id}@example.test`,
        emailVerified: true,
      },
    });
    await prisma.organization.create({
      data: { id, name: "Desktop wake", slug: id, createdAt },
    });
    await prisma.space.create({
      data: { id, organizationId: id, name: "Desktop wake", isDefault: true },
    });
    const bot = await prisma.bot.create({
      data: { spaceId: id, userId: id, name: "Desktop wake", color: "ink" },
    });
    await prisma.teamDesktop.create({
      data: {
        botId: bot.id,
        displayIndex: 101,
        ownerToken: "desktop-owner-placeholder",
        state: "stopped",
      },
    });

    const alive = new Set<number>();
    const host: TeamDesktopHost = {
      async xSocketExists() {
        return false;
      },
      async tokenFileExists() {
        return false;
      },
      async portListening() {
        return false;
      },
      async windowAlive(displayIndex) {
        return alive.has(displayIndex);
      },
      async startWindow(displayIndex) {
        const row = await prisma.teamDesktop.findUniqueOrThrow({ where: { botId: bot.id } });
        expect(row.state).toBe("booting");
        alive.add(displayIndex);
      },
      async stopWindow() {
        return undefined;
      },
      async cleanWindow() {
        return undefined;
      },
      async cleanOrphans() {
        return undefined;
      },
      async purge() {
        return undefined;
      },
    };
    const alloc = createTeamDesktopAllocator({
      store: createPrismaTeamDesktopStore(prisma),
      host,
    });

    const binding = await alloc.ensure(bot.id);
    expect(binding.displayIndex).toBe(101);
    const row = await prisma.teamDesktop.findUniqueOrThrow({ where: { botId: bot.id } });
    expect(row.state).toBe("running");
    expect(row.lastUsedAt).not.toBeNull();
  });
});
