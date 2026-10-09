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

  it("stops a stale running desktop from the socket sweep, then wakes it", async () => {
    const db = createDb(databaseUrl!);
    const seen: string[] = [];
    try {
      const id = randomUUID();
      organizationIds.push(id);
      userIds.push(id);
      const createdAt = new Date();
      await db.prisma.user.create({
        data: {
          id,
          name: "Desktop socket",
          email: `${id}@example.test`,
          emailVerified: true,
        },
      });
      await db.prisma.organization.create({
        data: { id, name: "Desktop socket", slug: id, createdAt },
      });
      await db.prisma.space.create({
        data: { id, organizationId: id, name: "Desktop socket", isDefault: true },
      });
      const bot = await db.prisma.bot.create({
        data: { spaceId: id, userId: id, name: "Desktop socket", color: "ink" },
      });
      const displayIndex = 121;
      await db.prisma.teamDesktop.create({
        data: {
          botId: bot.id,
          displayIndex,
          ownerToken: "desktop-owner-placeholder",
          state: "running",
        },
      });

      const sockets = new Set<number>();
      const alive = new Set<number>();
      const cleans: number[] = [];
      const host: TeamDesktopHost = {
        async xSocketExists(index) {
          if (index !== displayIndex) return true;
          return sockets.has(index);
        },
        async tokenFileExists() {
          return false;
        },
        async portListening() {
          return false;
        },
        async windowAlive(index) {
          if (index !== displayIndex) return true;
          return alive.has(index);
        },
        async startWindow(index) {
          const current = await db.prisma.teamDesktop.findUniqueOrThrow({
            where: { botId: bot.id },
          });
          expect(current.state).toBe("booting");
          alive.add(index);
          sockets.add(index);
        },
        async stopWindow() {
          return undefined;
        },
        async cleanWindow(index) {
          cleans.push(index);
        },
        async cleanOrphans() {
          return undefined;
        },
        async purge() {
          return undefined;
        },
      };
      const alloc = createTeamDesktopAllocator({
        store: createPrismaTeamDesktopStore(db.prisma),
        host,
        onState: (_botId, state) => {
          seen.push(state);
        },
      });

      await alloc.sweepMissingDisplays();
      const stopped = await db.prisma.teamDesktop.findUniqueOrThrow({ where: { botId: bot.id } });
      expect(stopped.state).toBe("stopped");
      expect(stopped.ownerToken).toBe("desktop-owner-placeholder");
      expect(seen).toEqual(["suspended"]);
      expect(cleans).toEqual([displayIndex]);

      await alloc.sweepMissingDisplays();
      await alloc.noteDisplayGone(displayIndex);
      await alloc.noteDisplayGone(20);
      expect(cleans).toEqual([displayIndex]);

      const binding = await alloc.ensure(bot.id);
      expect(binding.displayIndex).toBe(displayIndex);
      expect(binding.ownerToken).toBe("desktop-owner-placeholder");
      const running = await db.prisma.teamDesktop.findUniqueOrThrow({ where: { botId: bot.id } });
      expect(running.state).toBe("running");
      expect(seen).toEqual(["suspended", "booting", "running"]);

      sockets.delete(displayIndex);
      alive.delete(displayIndex);
      await alloc.noteDisplayGone(displayIndex);
      const again = await db.prisma.teamDesktop.findUniqueOrThrow({ where: { botId: bot.id } });
      expect(again.state).toBe("stopped");
      expect(cleans).toEqual([displayIndex, displayIndex, displayIndex]);
      expect(seen).toEqual(["suspended", "booting", "running", "suspended"]);
    } finally {
      await db.prisma.$disconnect();
      await db.pool.end();
    }
  });
});
