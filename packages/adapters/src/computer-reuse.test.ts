import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import type { AdapterContext, JobPublisher } from "@rakazo/adapter-kit";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComputerBusyError, provisionComputer } from "./computer-lifecycle.js";
import { DockerSandboxProvider } from "./docker-sandbox.js";
import { FakeSandboxProvider } from "./fake-sandbox.js";
import { LocalAgentHomeStore } from "./home.js";
import { HostAwareSandbox } from "./host-aware-sandbox.js";
import { ConnectSandHost, SAND_DISPLAY_HEADER } from "./sand-host.js";
import { SandSandboxProvider } from "./sand-sandbox.js";
import { MappedSandSeatPolicy } from "./sand-seat.js";
import {
  createTeamDesktopAllocator,
  type TeamDesktopHost,
  type TeamDesktopRecord,
  type TeamDesktopState,
  type TeamDesktopStore,
} from "./team-desktop.js";

const context = {
  operationId: "test",
  traceId: "test",
  spaceId: "space",
  userId: "user",
  botId: "bot",
  signal: new AbortController().signal,
} satisfies AdapterContext;

async function fixture() {
  const directory = await mkdtemp(path.join(process.cwd(), ".computer-reuse-"));
  const row = {
    id: "computer",
    homeKey: "bot",
    providerRef: "provider",
    kind: "docker",
    scope: "team",
    state: "running",
    screenGeneration: 7,
    maintenanceId: null as string | null,
    controlLeaseId: null,
    updatedAt: new Date("2024-01-01T00:00:00Z"),
  };
  let assigned = true;
  const updateMany = vi.fn(async ({ where, data }) => {
    if (
      !assigned ||
      Object.entries(where).some(
        ([key, value]) => key in row && row[key as keyof typeof row] !== value,
      )
    )
      return { count: 0 };
    // Model the database trigger that revokes viewers on a lifecycle transition.
    if (
      data.state &&
      data.state !== row.state &&
      !(row.state === "booting" && data.state === "running")
    ) {
      row.screenGeneration++;
    }
    Object.assign(row, data);
    return { count: 1 };
  });
  const docker = new DockerSandboxProvider("http://supervisor.test", "test-token");
  const ref = {
    id: "provider",
    providerRef: "provider",
    botId: "bot",
    kind: "docker" as const,
    fresh: false,
  };
  const provision = vi.spyOn(docker, "provision").mockResolvedValue(ref);
  const prepare = vi.spyOn(docker, "prepare");
  const execute = vi.spyOn(docker, "execute").mockImplementation(async function* () {
    yield { type: "exit", code: 0 };
  });
  const sandbox = new HostAwareSandbox(docker, new FakeSandboxProvider(), async () => false);
  const deps = {
    prisma: {
      computer: { findUniqueOrThrow: vi.fn(async () => ({ ...row })), updateMany },
    } as unknown as PrismaClient,
    sandbox,
    home: new LocalAgentHomeStore(directory),
    jobs: {} as JobPublisher,
    events: {} as ThreadEvents,
    dataDir: directory,
  };
  return {
    row,
    deps,
    provision,
    prepare,
    execute,
    updateMany,
    unassign: () => {
      assigned = false;
    },
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("running Docker computer reuse", () => {
  it.each([true, false, "unavailable", "stopped"])(
    "preserves viewer authorization only for a confirmed running reference: %s",
    async (running) => {
      const f = await fixture();
      const fetchMock = vi.fn(async () =>
        Response.json(
          { running: running === true },
          { status: running === "unavailable" ? 503 : 200 },
        ),
      );
      vi.stubGlobal("fetch", fetchMock);
      if (running === "stopped") f.row.state = "stopped";
      try {
        await provisionComputer(f.deps, "computer", context, "bot");
        expect(f.row.state).toBe("running");
        expect(f.row.screenGeneration).toBe(running === true ? 7 : 8);
        expect(f.provision).toHaveBeenCalledTimes(running === true ? 0 : 1);
        expect(f.prepare).toHaveBeenCalledOnce();
        expect(f.execute).toHaveBeenCalledWith(
          expect.objectContaining({ providerRef: "provider" }),
          expect.objectContaining({ argv: expect.arrayContaining(["mkdir", "shared"]) }),
          context,
        );
        if (running !== "stopped") {
          expect(fetchMock).toHaveBeenCalledWith(
            "http://supervisor.test/computers/provider",
            expect.objectContaining({
              method: "GET",
              headers: expect.objectContaining({
                "x-rakazo-bot-id": "bot",
                "x-rakazo-space-id": "space",
              }),
            }),
          );
        } else expect(fetchMock).not.toHaveBeenCalled();
      } finally {
        await f.cleanup();
      }
    },
  );

  it.each(["state", "provider", "kind", "generation", "maintenance", "ownership", "cancel"])(
    "rejects reuse when %s changes during the read-only probe",
    async (change) => {
      const f = await fixture();
      const abort = new AbortController();
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          if (change === "state") f.row.state = "stopped";
          if (change === "provider") f.row.providerRef = "replacement";
          if (change === "kind") f.row.kind = "desktop";
          if (change === "generation") f.row.screenGeneration++;
          if (change === "maintenance") f.row.maintenanceId = "maintenance";
          if (change === "ownership") f.unassign();
          if (change === "cancel") abort.abort(new Error("cancelled"));
          return Response.json({ running: true });
        }),
      );
      try {
        await expect(
          provisionComputer(f.deps, "computer", { ...context, signal: abort.signal }),
        ).rejects.toThrow(change === "cancel" ? "cancelled" : new ComputerBusyError());
        if (change !== "cancel") {
          expect(f.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({
              where: expect.objectContaining({ bots: { some: { id: "bot", archivedAt: null } } }),
            }),
          );
        } else expect(f.updateMany).not.toHaveBeenCalled();
        expect(f.provision).not.toHaveBeenCalled();
        expect(f.prepare).not.toHaveBeenCalled();
      } finally {
        await f.cleanup();
      }
    },
  );
});

const DISPLAY = 121;

class SandReuseStore implements TeamDesktopStore {
  readonly rows = new Map<string, TeamDesktopRecord>();

  async getByBot(botId: string) {
    const row = this.rows.get(botId);
    return row ? { ...row } : null;
  }

  async list() {
    return [...this.rows.values()].map((row) => ({ ...row }));
  }

  async insert(row: TeamDesktopRecord) {
    this.rows.set(row.botId, { ...row });
  }

  async update(botId: string, patch: Partial<Pick<TeamDesktopRecord, "state" | "lastUsedAt">>) {
    const current = this.rows.get(botId);
    if (!current) throw new Error(`missing ${botId}`);
    this.rows.set(botId, { ...current, ...patch });
  }

  async delete(botId: string) {
    this.rows.delete(botId);
  }
}

class SandSignalHost implements TeamDesktopHost {
  readonly sockets = new Set<number>();
  readonly ports = new Set<number>();
  readonly starts: number[] = [];
  failStart = false;

  private guard(displayIndex: number) {
    if (displayIndex < 101 || displayIndex > 150) {
      throw new Error(`host touched display ${displayIndex}`);
    }
  }

  async xSocketExists(displayIndex: number) {
    this.guard(displayIndex);
    return this.sockets.has(displayIndex);
  }

  async tokenFileExists(displayIndex: number) {
    this.guard(displayIndex);
    return false;
  }

  async portListening(port: number) {
    return this.ports.has(port);
  }

  async windowAlive(displayIndex: number) {
    this.guard(displayIndex);
    return this.sockets.has(displayIndex) && this.ports.has(14000 + displayIndex);
  }

  async startWindow(displayIndex: number) {
    this.guard(displayIndex);
    this.starts.push(displayIndex);
    if (this.failStart) throw new Error("team desktop wake failed");
    this.sockets.add(displayIndex);
    this.ports.add(14000 + displayIndex);
  }

  async stopWindow(displayIndex: number) {
    this.guard(displayIndex);
    this.sockets.delete(displayIndex);
    this.ports.delete(14000 + displayIndex);
  }

  async cleanWindow(displayIndex: number) {
    this.guard(displayIndex);
  }

  async cleanOrphans() {
    return undefined;
  }

  async purge(displayIndex: number) {
    this.guard(displayIndex);
  }
}

function frame(flags: number, value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(5);
  header[0] = flags;
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

async function sandReuse(state: TeamDesktopState) {
  const directory = await mkdtemp(path.join(process.cwd(), ".sand-reuse-"));
  const computer = {
    id: "computer",
    homeKey: "team-space",
    providerRef: "team-desktop",
    kind: "sand",
    scope: "team",
    state: "running",
    screenGeneration: 7,
    maintenanceId: null as string | null,
    controlLeaseId: null,
    updatedAt: new Date("2024-01-01T00:00:00Z"),
  };
  const updateMany = vi.fn(async ({ where, data }) => {
    if (
      Object.entries(where).some(
        ([key, value]) => key in computer && computer[key as keyof typeof computer] !== value,
      )
    ) {
      return { count: 0 };
    }
    if (
      data.state &&
      data.state !== computer.state &&
      !(computer.state === "booting" && data.state === "running")
    ) {
      computer.screenGeneration++;
    }
    Object.assign(computer, data);
    return { count: 1 };
  });
  const store = new SandReuseStore();
  const stamped = new Date("2026-10-09T00:00:00.000Z");
  await store.insert({
    botId: "bot",
    displayIndex: DISPLAY,
    ownerToken: "fixture-owner-token",
    state,
    lastUsedAt: state === "running" ? stamped : null,
    createdAt: stamped,
    updatedAt: stamped,
  });
  const signalHost = new SandSignalHost();
  if (state === "running") {
    signalHost.sockets.add(DISPLAY);
    signalHost.ports.add(14000 + DISPLAY);
  }
  let clock = stamped.getTime();
  const desktops = createTeamDesktopAllocator({
    store,
    host: signalHost,
    ensureTimeoutMs: 1_000,
    now: () => new Date(clock),
    sleep: async (ms) => {
      clock += ms;
    },
    members: async () => ["bot"],
  });
  const fetchMock = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/GetCapabilities")) return Response.json({ computerUseSupported: true });
    if (url.endsWith("/Exec")) {
      return new Response(
        Buffer.concat([
          frame(0, { stdoutEvent: { data: "" } }),
          frame(0, { exitEvent: { exitCode: 0 } }),
          frame(2, {}),
        ]),
      );
    }
    return new Response("no", { status: 404 });
  });
  const sandbox = new SandSandboxProvider({
    policy: new MappedSandSeatPolicy(new Map()),
    host: new ConnectSandHost({
      baseUrl: "http://127.0.0.1:14020",
      token: "test-sand-token",
      fetch: fetchMock,
    }),
    teamDesktops: desktops,
  });
  const provision = vi.spyOn(sandbox, "provision");
  const deps = {
    prisma: {
      computer: { findUniqueOrThrow: vi.fn(async () => ({ ...computer })), updateMany },
    } as unknown as PrismaClient,
    sandbox,
    home: new LocalAgentHomeStore(directory),
    jobs: {} as JobPublisher,
    events: {} as ThreadEvents,
    dataDir: directory,
  };
  return {
    computer,
    deps,
    store,
    signalHost,
    provision,
    updateMany,
    fetchMock,
    boot: () => provisionComputer(deps, "computer", context, "bot"),
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

function claimedStates(updateMany: ReturnType<typeof vi.fn>) {
  return updateMany.mock.calls.map((call) => {
    const data = (call[0] as { data?: { state?: string } }).data;
    return data?.state;
  });
}

describe("running sand team desktop reuse", () => {
  it("keeps screen generation across turns when the desktop is already up", async () => {
    const f = await sandReuse("running");
    try {
      await f.boot();
      await f.boot();
      expect(f.computer.state).toBe("running");
      expect(f.computer.screenGeneration).toBe(7);
      expect(f.signalHost.starts).toEqual([]);
      expect(f.provision).not.toHaveBeenCalled();
      expect(claimedStates(f.updateMany)).toEqual([undefined, undefined]);
      expect(f.store.rows.get("bot")?.state).toBe("running");
      const displays = f.fetchMock.mock.calls.map((call) => {
        return new Headers(call[1]?.headers).get(SAND_DISPLAY_HEADER);
      });
      expect(displays.length).toBeGreaterThan(0);
      expect(displays.every((display) => display === String(DISPLAY))).toBe(true);
    } finally {
      await f.cleanup();
    }
  });

  it("wakes a sleeping desktop once, then reuses it", async () => {
    const f = await sandReuse("stopped");
    try {
      await f.boot();
      expect(f.signalHost.starts).toEqual([DISPLAY]);
      expect(f.computer.state).toBe("running");
      expect(f.computer.screenGeneration).toBe(8);
      expect(claimedStates(f.updateMany)).toEqual(["booting", "running"]);
      expect(f.store.rows.get("bot")?.state).toBe("running");
      expect(f.provision).toHaveBeenCalledTimes(1);

      await f.boot();
      expect(f.signalHost.starts).toEqual([DISPLAY]);
      expect(f.computer.screenGeneration).toBe(8);
      expect(f.computer.state).toBe("running");
      expect(f.provision).toHaveBeenCalledTimes(1);
      expect(claimedStates(f.updateMany)).toEqual(["booting", "running", undefined]);
    } finally {
      await f.cleanup();
    }
  });

  it("leaves the computer running and does not bump generation when ensure fails", async () => {
    const f = await sandReuse("stopped");
    f.signalHost.failStart = true;
    try {
      await expect(f.boot()).rejects.toThrow("team desktop wake failed");
      await expect(f.boot()).rejects.toThrow("team desktop wake failed");
      await expect(f.boot()).rejects.toThrow("team desktop wake failed");
      expect(f.computer.state).toBe("running");
      expect(f.computer.screenGeneration).toBe(7);
      expect(f.updateMany).not.toHaveBeenCalled();
      expect(f.provision).not.toHaveBeenCalled();
      expect(f.store.rows.get("bot")?.state).toBe("stopped");
      expect(f.signalHost.starts).toEqual([DISPLAY, DISPLAY, DISPLAY]);
    } finally {
      await f.cleanup();
    }
  });
});
