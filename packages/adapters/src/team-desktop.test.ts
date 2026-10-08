import { HUB_SPAWN_KEY_PREFIX, VISIBLE_ROSTER_BOT_WHERE } from "@rakazo/core";
import type { LogEvent } from "@rakazo/logging";
import { createLogger, installLogger } from "@rakazo/logging";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertTeamDesktopIndex,
  createTeamDesktopAllocator,
  isTeamDesktopTmpLeftover,
  TeamDesktopExhaustedError,
  type TeamDesktopHost,
  TeamDesktopLimitError,
  TeamDesktopMissingError,
  type TeamDesktopRecord,
  type TeamDesktopState,
  type TeamDesktopStore,
  teamDesktopAllocatorForProvider,
  teamDesktopConfigFromEnv,
  teamDesktopMemberBotIds,
  teamDesktopMemberBotWhere,
  teamDesktopPurgePaths,
} from "./team-desktop.js";
import { createLinuxTeamDesktopHost } from "./team-desktop-host.js";

class MemoryTeamDesktopStore implements TeamDesktopStore {
  readonly rows = new Map<string, TeamDesktopRecord>();

  async getByBot(botId: string) {
    const row = this.rows.get(botId);
    return row ? { ...row, lastUsedAt: row.lastUsedAt ? new Date(row.lastUsedAt) : null } : null;
  }

  async list() {
    return [...this.rows.values()].map((row) => ({
      ...row,
      lastUsedAt: row.lastUsedAt ? new Date(row.lastUsedAt) : null,
    }));
  }

  async insert(row: TeamDesktopRecord) {
    if ([...this.rows.values()].some((existing) => existing.botId === row.botId)) {
      throw Object.assign(new Error("unique"), { code: "P2002" });
    }
    if ([...this.rows.values()].some((existing) => existing.displayIndex === row.displayIndex)) {
      throw Object.assign(new Error("unique"), { code: "P2002" });
    }
    this.rows.set(row.botId, { ...row });
  }

  async update(botId: string, patch: Partial<Pick<TeamDesktopRecord, "state" | "lastUsedAt">>) {
    const row = this.rows.get(botId);
    if (!row) throw new Error(`missing ${botId}`);
    this.rows.set(botId, { ...row, ...patch, updatedAt: new Date() });
  }

  async delete(botId: string) {
    this.rows.delete(botId);
  }
}

class FakeTeamDesktopHost implements TeamDesktopHost {
  readonly xSockets = new Set<number>();
  readonly tokenFiles = new Set<number>();
  readonly ports = new Set<number>();
  readonly alive = new Set<number>();
  readonly starts: Array<{ displayIndex: number; ownerToken: string }> = [];
  readonly stops: number[] = [];
  readonly purges: number[] = [];
  readonly probedIndexes: number[] = [];
  readonly probedPorts: number[] = [];
  failStartWithToken = false;
  blockStart = false;
  releaseStart: (() => void) | undefined;

  private guard(displayIndex: number) {
    this.probedIndexes.push(displayIndex);
    if (displayIndex <= 100 || displayIndex > 150) {
      throw new Error(`host touched display ${displayIndex}`);
    }
  }

  async xSocketExists(displayIndex: number) {
    this.guard(displayIndex);
    return this.xSockets.has(displayIndex);
  }

  async tokenFileExists(displayIndex: number) {
    this.guard(displayIndex);
    return this.tokenFiles.has(displayIndex);
  }

  async portListening(port: number) {
    this.probedPorts.push(port);
    return this.ports.has(port);
  }

  async windowAlive(displayIndex: number) {
    this.guard(displayIndex);
    return this.alive.has(displayIndex);
  }

  async startWindow(displayIndex: number, ownerToken: string) {
    this.guard(displayIndex);
    this.starts.push({ displayIndex, ownerToken });
    if (this.failStartWithToken) throw new Error(`start-window failed ${ownerToken}`);
    if (this.blockStart) {
      await new Promise<void>((resolve) => {
        this.releaseStart = resolve;
      });
    }
    this.alive.add(displayIndex);
  }

  async stopWindow(displayIndex: number) {
    this.guard(displayIndex);
    this.stops.push(displayIndex);
    this.alive.delete(displayIndex);
  }

  async purge(displayIndex: number) {
    this.guard(displayIndex);
    this.purges.push(displayIndex);
    this.xSockets.delete(displayIndex);
    this.tokenFiles.delete(displayIndex);
  }
}

function harness(options?: {
  maxRunning?: number;
  idleMinutes?: number;
  now?: Date;
  ensureTimeoutMs?: number;
  members?: () => Promise<readonly string[]>;
}) {
  const store = new MemoryTeamDesktopStore();
  const host = new FakeTeamDesktopHost();
  let now = options?.now ?? new Date("2026-10-07T12:00:00.000Z");
  const alloc = createTeamDesktopAllocator({
    store,
    host,
    maxRunning: options?.maxRunning,
    idleMinutes: options?.idleMinutes,
    ensureTimeoutMs: options?.ensureTimeoutMs,
    members: options?.members,
    now: () => now,
    sleep: async () => {
      now = new Date(now.getTime() + 1_000);
    },
  });
  return {
    store,
    host,
    alloc,
    setNow(next: Date) {
      now = next;
    },
    advance(ms: number) {
      now = new Date(now.getTime() + ms);
    },
  };
}

function row(store: MemoryTeamDesktopStore, botId: string): TeamDesktopRecord {
  const found = store.rows.get(botId);
  if (!found) throw new Error(`missing ${botId}`);
  return found;
}

afterEach(() => {
  installLogger(createLogger({ service: "test", level: "off", sinks: [] }));
});

describe("team desktop index selection", () => {
  it("skips an index held by a row, an X socket, a token file, or any desktop port", async () => {
    const { alloc, host } = harness();
    host.xSockets.add(101);
    host.tokenFiles.add(102);
    host.ports.add(9222 + 103);
    host.ports.add(14000 + 104);
    host.ports.add(5900 + 105);
    host.ports.add(13600 + 106);
    const reserved = await alloc.reserve("bot");
    expect(reserved).toMatchObject({ botId: "bot", displayIndex: 107, state: "reserved" });
    expect(reserved).not.toHaveProperty("ownerToken");
    expect(host.starts).toEqual([]);
  });

  it("returns the row another reserve already inserted", async () => {
    const { alloc, store } = harness();
    const original = store.insert.bind(store);
    store.insert = async (rowToInsert) => {
      await original(rowToInsert);
      throw Object.assign(new Error("unique bot"), { code: "P2002" });
    };
    const reserved = await alloc.reserve("bot");
    expect(reserved.displayIndex).toBe(row(store, "bot").displayIndex);
    expect(store.rows.size).toBe(1);
    expect(reserved).not.toHaveProperty("ownerToken");
  });

  it("picks the next index when the first choice is taken", async () => {
    const { alloc, store } = harness();
    const original = store.insert.bind(store);
    store.insert = async (rowToInsert) => {
      if (rowToInsert.botId === "bot" && rowToInsert.displayIndex === 101) {
        await original({ ...rowToInsert, botId: "other" });
        throw Object.assign(new Error("unique index"), { code: "P2002" });
      }
      await original(rowToInsert);
    };
    const reserved = await alloc.reserve("bot");
    expect(reserved.displayIndex).toBe(102);
    expect(row(store, "other").displayIndex).toBe(101);
  });

  it("keeps an existing row instead of allocating another index", async () => {
    const { alloc } = harness();
    const first = await alloc.reserve("bot");
    const again = await alloc.reserve("bot");
    expect(again.displayIndex).toBe(first.displayIndex);
    expect(again.state).toBe("reserved");
  });

  it("reports a clear error when 101-150 is full", async () => {
    const { alloc, host } = harness();
    for (let displayIndex = 101; displayIndex <= 150; displayIndex += 1) {
      host.xSockets.add(displayIndex);
    }
    await expect(alloc.reserve("bot")).rejects.toBeInstanceOf(TeamDesktopExhaustedError);
    await expect(alloc.reserve("bot")).rejects.toThrow("No free Team desktop in 101-150.");
    expect(host.probedIndexes.every((index) => index >= 101 && index <= 150)).toBe(true);
    expect(host.starts).toEqual([]);
  });
});

describe("team desktop lifecycle", () => {
  it("reserves, wakes, stops, wakes the same index and token, then releases", async () => {
    const { alloc, host, store } = harness();
    const reserved = await alloc.reserve("bot");
    expect(reserved.state).toBe("reserved");
    expect(host.starts).toEqual([]);
    const token = row(store, "bot").ownerToken;
    const displayIndex = reserved.displayIndex;

    const running = await alloc.ensure("bot");
    expect(running).toEqual({ displayIndex, ownerToken: token });
    expect(row(store, "bot").state).toBe<TeamDesktopState>("running");
    expect(host.starts).toEqual([{ displayIndex, ownerToken: token }]);

    const stopped = await alloc.stop("bot");
    expect(stopped).toMatchObject({ displayIndex, state: "stopped" });
    expect(row(store, "bot").ownerToken).toBe(token);
    expect(host.stops).toEqual([displayIndex]);
    expect(host.purges).toEqual([displayIndex]);

    await alloc.ensure("bot");
    expect(host.starts).toEqual([
      { displayIndex, ownerToken: token },
      { displayIndex, ownerToken: token },
    ]);
    expect(row(store, "bot").state).toBe("running");

    await alloc.release("bot");
    expect(store.rows.has("bot")).toBe(false);
    expect(host.stops).toEqual([displayIndex, displayIndex]);
    expect(host.purges).toEqual([displayIndex, displayIndex]);
  });

  it("runs one ensure at a time for a bot", async () => {
    const { alloc, host } = harness();
    await alloc.reserve("bot");
    host.blockStart = true;
    const first = alloc.ensure("bot");
    await vi.waitFor(() => expect(host.starts).toHaveLength(1));
    const second = alloc.ensure("bot");
    host.blockStart = false;
    host.releaseStart?.();
    await Promise.all([first, second]);
    expect(host.starts).toHaveLength(1);
  });

  it("does not log the owner token", async () => {
    const events: LogEvent[] = [];
    installLogger(
      createLogger({
        service: "test",
        level: "debug",
        sinks: [
          {
            write(event) {
              events.push(event);
            },
          },
        ],
      }),
    );
    const { alloc, host, store } = harness();
    await alloc.reserve("bot");
    const token = row(store, "bot").ownerToken;
    await alloc.ensure("bot");
    await alloc.stop("bot");
    host.failStartWithToken = true;
    host.alive.clear();
    await expect(alloc.ensure("bot")).rejects.toThrow(Error);
    let thrown = "";
    try {
      await alloc.ensure("bot");
    } catch (error) {
      thrown = error instanceof Error ? `${error.name} ${error.message} ${error.stack ?? ""}` : "";
    }
    await alloc.release("bot");
    const dumped = JSON.stringify(events);
    expect(token.length).toBeGreaterThan(16);
    expect(dumped).not.toContain(token);
    expect(thrown).not.toContain(token);
    expect(dumped).toContain("team desktop reserved");
  });
});

describe("team desktop membership", () => {
  it("reserves a team-scope bot and releases a private, switched, or archived bot", async () => {
    const { alloc, host, store } = harness();
    await alloc.syncMembership(
      teamDesktopMemberBotIds([
        { id: "chief", archived: false, computerScope: "team" },
        { id: "private", archived: false, computerScope: "dedicated" },
        { id: "unassigned", archived: false, computerScope: null },
      ]),
    );
    expect(row(store, "chief").state).toBe("reserved");
    expect(store.rows.has("private")).toBe(false);
    expect(store.rows.has("unassigned")).toBe(false);
    expect(host.starts).toEqual([]);

    await alloc.syncMembership(
      teamDesktopMemberBotIds([
        { id: "chief", archived: false, computerScope: "team" },
        { id: "staff", archived: false, computerScope: "team" },
        { id: "private", archived: false, computerScope: "dedicated" },
      ]),
    );
    const chiefIndex = row(store, "chief").displayIndex;
    const staffIndex = row(store, "staff").displayIndex;
    expect(row(store, "staff").state).toBe("reserved");
    expect(staffIndex).not.toBe(chiefIndex);

    await alloc.syncMembership(
      teamDesktopMemberBotIds([
        { id: "chief", archived: false, computerScope: "team" },
        { id: "staff", archived: false, computerScope: "dedicated" },
      ]),
    );
    expect(store.rows.has("staff")).toBe(false);
    expect(host.stops).toEqual([staffIndex]);
    expect(host.purges).toEqual([staffIndex]);
    expect(store.rows.has("chief")).toBe(true);
    expect(host.stops).not.toContain(chiefIndex);

    await alloc.syncMembership(
      teamDesktopMemberBotIds([{ id: "chief", archived: true, computerScope: "team" }]),
    );
    expect(store.rows.has("chief")).toBe(false);
    expect(host.stops).toEqual([staffIndex, chiefIndex]);
    expect(host.purges).toEqual([staffIndex, chiefIndex]);
    expect(host.probedIndexes.every((index) => index >= 101 && index <= 150)).toBe(true);
  });

  it("gives a hub roster mirror no row", async () => {
    const { alloc, store } = harness();
    await alloc.syncMembership(
      teamDesktopMemberBotIds([
        {
          id: "mirror",
          archived: false,
          computerScope: "team",
          spawnKey: `${HUB_SPAWN_KEY_PREFIX}agent`,
        },
        { id: "chief", archived: false, computerScope: "team", spawnKey: null },
      ]),
    );
    expect(store.rows.has("mirror")).toBe(false);
    expect(row(store, "chief").state).toBe("reserved");
    expect(teamDesktopMemberBotWhere()).toEqual({
      archivedAt: null,
      computer: { is: { scope: "team" } },
      ...VISIBLE_ROSTER_BOT_WHERE,
    });
  });

  it("keeps create and archive working when 101-150 is full", async () => {
    const events: LogEvent[] = [];
    installLogger(
      createLogger({
        service: "test",
        level: "debug",
        sinks: [
          {
            write(event) {
              events.push(event);
            },
          },
        ],
      }),
    );
    const members = Array.from({ length: 51 }, (_, index) => `bot-${index}`);
    const { alloc, store, host } = harness();
    await expect(alloc.syncMembership(members)).resolves.toBeUndefined();
    expect(store.rows.size).toBe(50);
    expect(store.rows.has("bot-50")).toBe(false);
    const warning = events.find((event) => event.level === "warn");
    expect(warning?.message).toBe("team desktop band is full; extra members stay without a row");
    expect(warning?.skipped).toBe(1);
    const dumped = JSON.stringify(events);
    for (const held of store.rows.values()) {
      expect(dumped).not.toContain(held.ownerToken);
    }

    await expect(alloc.syncMembership(members.slice(1))).resolves.toBeUndefined();
    expect(store.rows.has("bot-0")).toBe(false);
    expect(store.rows.has("bot-50")).toBe(true);
    expect(store.rows.size).toBe(50);
    expect(host.stops.every((index) => index >= 101 && index <= 150)).toBe(true);

    await expect(
      alloc.syncMembership([...members.slice(2), "bot-51", "bot-52"]),
    ).resolves.toBeUndefined();
    expect(store.rows.has("bot-1")).toBe(false);
    expect(store.rows.size).toBe(50);
    expect(["bot-51", "bot-52"].filter((id) => store.rows.has(id))).toHaveLength(1);
  });

  it("reserves an unreserved member on demand and exhausts only that call", async () => {
    const { alloc, store, host } = harness({ members: async () => ["late"] });
    const binding = await alloc.ensure("late");
    expect(row(store, "late").displayIndex).toBe(binding.displayIndex);
    expect(host.starts).toEqual([
      { displayIndex: binding.displayIndex, ownerToken: binding.ownerToken },
    ]);
    await expect(alloc.ensure("other")).rejects.toBeInstanceOf(TeamDesktopMissingError);
    expect(store.rows.has("other")).toBe(false);

    const held = Array.from({ length: 50 }, (_, index) => `held-${index}`);
    const full = harness({ members: async () => [...held, "extra"] });
    await full.alloc.syncMembership(held);
    expect(full.store.rows.size).toBe(50);
    await expect(full.alloc.ensure("extra")).rejects.toBeInstanceOf(TeamDesktopExhaustedError);
    expect(full.store.rows.size).toBe(50);
    expect(full.store.rows.has("extra")).toBe(false);
    await expect(full.alloc.ensure("stranger")).rejects.toBeInstanceOf(TeamDesktopMissingError);
  });

  it("reserves on demand when membership is not configured", async () => {
    const { alloc, store } = harness();
    await alloc.ensure("bot");
    expect(row(store, "bot").state).toBe("running");
  });
});

describe("team desktop provider gate", () => {
  it("does not open the allocator unless the provider is sand", () => {
    for (const provider of ["fake", "docker", "e2b", "none"]) {
      const open = vi.fn(() => ({ id: "alloc" }));
      expect(teamDesktopAllocatorForProvider(provider, open)).toBeUndefined();
      expect(open).not.toHaveBeenCalled();
    }
    const open = vi.fn(() => ({ id: "alloc" }));
    expect(teamDesktopAllocatorForProvider("sand", open)).toEqual({ id: "alloc" });
    expect(open).toHaveBeenCalledOnce();
  });
});

describe("team desktop reconcile", () => {
  it("reaps orphans inside 101-150, marks dead rows stopped, and never touches other indexes", async () => {
    const { alloc, host, store, setNow } = harness();
    const started = new Date("2026-10-07T12:00:00.000Z");
    setNow(started);
    await alloc.reserve("dead");
    await alloc.ensure("dead");
    await alloc.reserve("idle");
    await alloc.ensure("idle");
    const deadIndex = row(store, "dead").displayIndex;
    const idleIndex = row(store, "idle").displayIndex;
    const deadToken = row(store, "dead").ownerToken;
    host.alive.delete(deadIndex);
    setNow(new Date(started.getTime() + 31 * 60_000));
    await alloc.reserve("live");
    await alloc.ensure("live");
    const liveIndex = row(store, "live").displayIndex;
    host.tokenFiles.add(130);
    host.stops.length = 0;
    host.purges.length = 0;
    host.probedIndexes.length = 0;
    host.probedPorts.length = 0;
    const startsBefore = host.starts.length;

    await alloc.reconcile();

    expect(host.starts).toHaveLength(startsBefore);
    expect(host.stops).toContain(130);
    expect(host.purges).toContain(130);
    expect(row(store, "dead").state).toBe("stopped");
    expect(row(store, "dead").ownerToken).toBe(deadToken);
    expect(row(store, "idle").state).toBe("stopped");
    expect(row(store, "live").state).toBe("running");
    expect(host.stops).not.toContain(liveIndex);
    expect(host.probedIndexes.every((index) => index >= 101 && index <= 150)).toBe(true);
    expect(host.probedPorts.every((port) => displayForPort(port) !== undefined)).toBe(true);
    expect(host.stops.every((index) => index >= 101 && index <= 150)).toBe(true);
    expect(host.purges.every((index) => index >= 101 && index <= 150)).toBe(true);
    expect(idleIndex).toBeGreaterThan(100);
    expect(host.starts.filter((call) => call.displayIndex === 130)).toEqual([]);
  });

  it("re-syncs team-computer membership before reclaiming orphans", async () => {
    const wanted = ["live"];
    const { alloc, host, store } = harness({ members: async () => wanted });
    await alloc.reserve("live");
    await alloc.reserve("gone");
    await alloc.ensure("gone");
    const goneIndex = row(store, "gone").displayIndex;
    host.stops.length = 0;
    host.purges.length = 0;

    await alloc.reconcile();

    expect(store.rows.has("gone")).toBe(false);
    expect(host.stops).toContain(goneIndex);
    expect(host.purges).toContain(goneIndex);
    expect(row(store, "live").state).toBe("reserved");
    expect(host.starts.every((call) => call.displayIndex !== row(store, "live").displayIndex)).toBe(
      true,
    );
  });
});

describe("team desktop running cap", () => {
  it("stops the longest-idle desktop when ensure would pass the cap", async () => {
    const { alloc, host, store, setNow } = harness({ maxRunning: 2 });
    const started = new Date("2026-10-07T12:00:00.000Z");
    setNow(started);
    await alloc.reserve("older");
    await alloc.ensure("older");
    setNow(new Date(started.getTime() + 10 * 60_000));
    await alloc.reserve("newer");
    await alloc.ensure("newer");
    const olderIndex = row(store, "older").displayIndex;
    setNow(new Date(started.getTime() + 50 * 60_000));
    await alloc.reserve("next");
    await alloc.ensure("next");
    expect(row(store, "older").state).toBe("stopped");
    expect(row(store, "newer").state).toBe("running");
    expect(row(store, "next").state).toBe("running");
    expect(host.stops).toContain(olderIndex);
  });

  it("refuses ensure when every running desktop is still in use", async () => {
    const { alloc, store, advance } = harness({ maxRunning: 1 });
    await alloc.reserve("busy");
    await alloc.ensure("busy");
    advance(60_000);
    await alloc.reserve("waiting");
    await expect(alloc.ensure("waiting")).rejects.toBeInstanceOf(TeamDesktopLimitError);
    await expect(alloc.ensure("waiting")).rejects.toThrow(
      "Team desktop limit reached (1 running). No idle desktop is available to stop.",
    );
    expect(row(store, "busy").state).toBe("running");
    expect(row(store, "waiting").state).toBe("reserved");
  });
});

describe("team desktop host bounds", () => {
  it("does not spawn host commands for an index outside 101-150", async () => {
    const command = vi.fn(async () => 0);
    const host = createLinuxTeamDesktopHost({ command });
    await expect(host.startWindow(100, "not-used")).rejects.toThrow(/outside 101-150/);
    await expect(host.stopWindow(151)).rejects.toThrow(/outside 101-150/);
    await expect(host.purge(2)).rejects.toThrow(/outside 101-150/);
    await expect(host.windowAlive(1)).rejects.toThrow(/outside 101-150/);
    expect(command).not.toHaveBeenCalled();
    expect(() => assertTeamDesktopIndex(50)).toThrow(/outside 101-150/);
  });

  it("selects only leftovers for that index", () => {
    const paths = teamDesktopPurgePaths(101, [
      "xvfb:101.log",
      "xvfb:100.log",
      "chrome:1010.log",
      "xfwm4:101.lock",
      "picom:10.log",
    ]);
    expect(paths).toContain("/tmp/xvfb:101.log");
    expect(paths).toContain("/tmp/xfwm4:101.lock");
    expect(paths).toContain("/tmp/.X11-unix/X101");
    expect(paths).toContain("/tmp/Fork-101");
    expect(paths).not.toContain("/tmp/xvfb:100.log");
    expect(paths).not.toContain("/tmp/chrome:1010.log");
    expect(paths).not.toContain("/tmp/picom:10.log");
    expect(paths.filter((entry) => entry.includes("Fork-"))).toEqual([
      "/tmp/Fork-101",
      "/home/box/.config/google-chrome/Fork-101",
      "/home/box/.config/chromium/Fork-101",
    ]);
    expect(isTeamDesktopTmpLeftover("plank:101.pid", 101)).toBe(true);
    expect(isTeamDesktopTmpLeftover("plank:1010.pid", 101)).toBe(false);
    expect(() => teamDesktopPurgePaths(20, ["xvfb:20.log"])).toThrow(/outside 101-150/);
  });

  it("reads idle, reconcile, and cap defaults from the environment", () => {
    expect(teamDesktopConfigFromEnv({})).toEqual({
      idleMinutes: 30,
      reconcileSeconds: 120,
      maxRunning: 4,
    });
  });
});

function displayForPort(port: number): number | undefined {
  for (const base of [9222, 14000, 5900, 13600]) {
    const displayIndex = port - base;
    if (displayIndex >= 101 && displayIndex <= 150) return displayIndex;
  }
  return undefined;
}
