import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type { LogEvent } from "@rakazo/logging";
import { createLogger, installLogger } from "@rakazo/logging";
import { afterEach, describe, expect, it, vi } from "vitest";
import { teamDesktopCdpBusyMessage, teamDesktopPorts } from "./team-desktop.js";
import { createLinuxTeamDesktopHost, START_WINDOW_BIN } from "./team-desktop-host.js";
import {
  cleanTeamDesktopOrphans,
  planTeamDesktopOrphanCleanup,
  readTeamDesktopProcTable,
  TEAM_DESKTOP_ORPHAN_GRACE_MS,
  type TeamDesktopOrphanControl,
  type TeamDesktopProc,
} from "./team-desktop-orphans.js";

const UID = 1000;
const tracked = new Set<number>();

function proc(
  overrides: Partial<TeamDesktopProc> & { pid: number; argv: readonly string[] },
): TeamDesktopProc {
  return {
    uid: UID,
    sid: overrides.pid,
    pgid: overrides.pid,
    startTicks: 1_000,
    ...overrides,
  };
}

function quietOrphans(
  list: TeamDesktopOrphanControl["list"] = async () => [],
): TeamDesktopOrphanControl {
  return {
    list,
    signal() {},
    alive: () => false,
    sleep: async () => {},
    uid: () => UID,
  };
}

afterEach(() => {
  installLogger(createLogger({ service: "test", level: "off", sinks: [] }));
  for (const pid of tracked) killTree(pid);
  tracked.clear();
});

describe("team desktop orphan selection", () => {
  it("selects a stopped start-desktop session and its dbus, and leaves a live Xvfb session", () => {
    const orphan = [
      proc({
        pid: 10,
        sid: 10,
        pgid: 10,
        startTicks: 100,
        argv: ["bash", "/usr/local/bin/start-desktop.sh"],
      }),
      proc({
        pid: 11,
        sid: 10,
        pgid: 10,
        startTicks: 101,
        argv: ["box-bounded-log", "--run", "/tmp/sand-window-101/start-desktop.log"],
      }),
      proc({
        pid: 12,
        sid: 10,
        pgid: 10,
        startTicks: 102,
        argv: ["tail", "-f", "/dev/null"],
      }),
    ];
    const live = [
      proc({
        pid: 30,
        sid: 30,
        pgid: 30,
        startTicks: 200,
        argv: ["bash", "/usr/local/bin/start-desktop.sh"],
      }),
      proc({
        pid: 31,
        sid: 30,
        pgid: 30,
        startTicks: 201,
        argv: ["box-bounded-log", "--run", "/tmp/sand-window-101/start-desktop.log"],
      }),
      proc({ pid: 32, sid: 30, pgid: 30, startTicks: 210, argv: ["Xvfb", ":101", "-screen", "0"] }),
    ];
    const procs = [
      ...orphan,
      ...live,
      proc({
        pid: 20,
        sid: 20,
        pgid: 20,
        startTicks: 110,
        argv: ["dbus-daemon", "--session"],
        display: ":101",
      }),
      proc({
        pid: 40,
        sid: 40,
        pgid: 40,
        startTicks: 220,
        argv: ["dbus-daemon", "--session"],
        display: ":101.0",
      }),
      proc({
        pid: 41,
        sid: 41,
        pgid: 41,
        startTicks: 50,
        argv: ["dbus-daemon"],
        display: ":101",
      }),
      proc({
        pid: 50,
        sid: 50,
        pgid: 50,
        argv: ["bash", "/usr/local/bin/start-desktop.sh"],
      }),
      proc({
        pid: 51,
        sid: 50,
        pgid: 50,
        argv: ["box-bounded-log", "--run", "/tmp/sand-window-20/start-desktop.log"],
      }),
      proc({ pid: 52, sid: 52, pgid: 52, argv: ["dbus-daemon"], display: ":20" }),
      proc({
        pid: 60,
        sid: 60,
        pgid: 60,
        argv: [
          "google-chrome",
          "--headless=new",
          "--remote-debugging-port=9333",
          "--user-data-dir=/tmp/chief-cdp-profile",
        ],
      }),
      proc({
        pid: 70,
        sid: 70,
        pgid: 70,
        argv: ["bash", "/usr/local/bin/start-desktop.sh"],
      }),
      proc({
        pid: 71,
        sid: 70,
        pgid: 70,
        argv: ["box-bounded-log", "--run", "/tmp/sand-window-1010/start-desktop.log"],
      }),
      proc({ pid: 72, sid: 72, pgid: 72, argv: ["dbus-daemon"], display: ":1010" }),
      proc({ pid: 73, sid: 73, pgid: 73, argv: ["Xvfb", ":1010"] }),
      proc({
        pid: 80,
        uid: 7,
        sid: 80,
        pgid: 80,
        argv: ["bash", "/usr/local/bin/start-desktop.sh"],
      }),
      proc({
        pid: 81,
        uid: 7,
        sid: 80,
        pgid: 80,
        argv: ["box-bounded-log", "--run", "/tmp/sand-window-101/start-desktop.log"],
      }),
    ];

    const plan = planTeamDesktopOrphanCleanup(101, procs, UID, new Set());
    expect(plan.groups).toEqual([{ pgid: 10, pids: [10, 11, 12] }]);
    expect(plan.dbusPids).toEqual([20]);
    expect(plan.groups.some((group) => group.pids.includes(30) || group.pgid === 30)).toBe(false);
    expect(plan.dbusPids).not.toEqual(expect.arrayContaining([40, 41, 52, 72]));

    const seat = planTeamDesktopOrphanCleanup(101, procs, UID, new Set());
    expect(seat.groups.some((group) => group.pids.includes(50))).toBe(false);
    expect(() => planTeamDesktopOrphanCleanup(20, procs, UID, new Set())).toThrow(
      /outside 101-150/,
    );
    expect(() => planTeamDesktopOrphanCleanup(100, procs, UID, new Set())).toThrow(
      /outside 101-150/,
    );
    expect(() => planTeamDesktopOrphanCleanup(151, procs, UID, new Set())).toThrow(
      /outside 101-150/,
    );

    const held = planTeamDesktopOrphanCleanup(101, procs, UID, new Set([10]));
    expect(held.groups).toEqual([]);

    expect(planTeamDesktopOrphanCleanup(101, [], UID, new Set())).toEqual({
      groups: [],
      dbusPids: [],
    });
  });

  it("sends TERM, then KILL after the grace when the session is still alive", async () => {
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const sleeps: number[] = [];
    const procs = [
      proc({
        pid: 10,
        sid: 10,
        pgid: 10,
        startTicks: 100,
        argv: ["bash", "/usr/local/bin/start-desktop.sh"],
      }),
      proc({
        pid: 11,
        sid: 10,
        pgid: 10,
        startTicks: 101,
        argv: ["box-bounded-log", "--run", "/tmp/sand-window-121/start-desktop.log"],
      }),
      proc({
        pid: 20,
        sid: 20,
        pgid: 20,
        startTicks: 110,
        argv: ["dbus-daemon"],
        display: ":121",
      }),
    ];
    await cleanTeamDesktopOrphans([121], {
      list: async () => procs,
      signal(pid, signal) {
        signals.push({ pid, signal });
      },
      alive: () => true,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      uid: () => UID,
    });
    expect(sleeps).toEqual([TEAM_DESKTOP_ORPHAN_GRACE_MS]);
    expect(signals).toContainEqual({ pid: -10, signal: "SIGTERM" });
    expect(signals).toContainEqual({ pid: 20, signal: "SIGTERM" });
    expect(signals).toContainEqual({ pid: -10, signal: "SIGKILL" });
    expect(signals).toContainEqual({ pid: 20, signal: "SIGKILL" });
    expect(signals.some((call) => call.pid === -1 || call.pid === 0 || call.pid === 1)).toBe(false);
  });

  it("does not KILL a session that exited on TERM, and a second pass signals nothing", async () => {
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    let listed = 0;
    const procs = [
      proc({
        pid: 10,
        sid: 10,
        pgid: 10,
        startTicks: 100,
        argv: ["bash", "/usr/local/bin/start-desktop.sh"],
      }),
      proc({
        pid: 11,
        sid: 10,
        pgid: 10,
        startTicks: 101,
        argv: ["box-bounded-log", "--run", "/tmp/sand-window-122/start-desktop.log"],
      }),
    ];
    const control: TeamDesktopOrphanControl = {
      list: async () => {
        listed += 1;
        return listed === 1 ? procs : [];
      },
      signal(pid, signal) {
        signals.push({ pid, signal });
      },
      alive: () => false,
      sleep: async () => {},
      uid: () => UID,
    };
    await cleanTeamDesktopOrphans([122], control);
    const afterFirst = signals.length;
    expect(afterFirst).toBeGreaterThan(0);
    expect(signals.some((call) => call.signal === "SIGKILL")).toBe(false);
    expect(signals.some((call) => call.signal === "SIGTERM")).toBe(true);
    await cleanTeamDesktopOrphans([122], control);
    expect(signals).toHaveLength(afterFirst);
  });
});

describe("team desktop host cleanup", () => {
  it("does not scan or signal an index outside 101-150", async () => {
    let listed = false;
    const host = createLinuxTeamDesktopHost({
      command: vi.fn(async () => 0),
      orphans: quietOrphans(async () => {
        listed = true;
        return [];
      }),
    });
    await expect(host.cleanWindow(20)).rejects.toThrow(/outside 101-150/);
    await expect(host.cleanWindow(151)).rejects.toThrow(/outside 101-150/);
    await expect(host.stopWindow(2)).rejects.toThrow(/outside 101-150/);
    expect(listed).toBe(false);
  });

  it("cleans only after stop-window exits 0 and logs counts without pids", async () => {
    const events: LogEvent[] = [];
    installLogger(
      createLogger({
        service: "test",
        level: "info",
        sinks: [
          {
            write(event) {
              events.push(event);
            },
          },
        ],
      }),
    );
    const signals: number[] = [];
    const procs = [
      proc({
        pid: 424242,
        sid: 424242,
        pgid: 424242,
        startTicks: 100,
        argv: ["bash", "/usr/local/bin/start-desktop.sh"],
      }),
      proc({
        pid: 424243,
        sid: 424242,
        pgid: 424242,
        startTicks: 101,
        argv: ["box-bounded-log", "--run", "/tmp/sand-window-123/start-desktop.log"],
      }),
      proc({
        pid: 424244,
        sid: 424244,
        pgid: 424244,
        startTicks: 110,
        argv: ["dbus-daemon"],
        display: ":123",
      }),
    ];
    const command = vi.fn(async () => 0);
    const failing = vi.fn(async () => 1);
    const failedSignals: number[] = [];
    const failed = createLinuxTeamDesktopHost({
      command: failing,
      orphans: {
        list: async () => procs,
        signal(pid) {
          failedSignals.push(pid);
        },
        alive: () => false,
        sleep: async () => {},
        uid: () => UID,
      },
    });
    await expect(failed.stopWindow(123)).rejects.toThrow(/stop-window exited 1/);
    expect(failedSignals).toEqual([]);
    const host = createLinuxTeamDesktopHost({
      command,
      orphans: {
        list: async () => procs,
        signal(pid) {
          signals.push(pid);
        },
        alive: () => false,
        sleep: async () => {},
        uid: () => UID,
      },
    });
    await host.stopWindow(123);
    expect(failing).toHaveBeenCalledOnce();
    expect(signals).toContain(-424242);
    expect(signals).toContain(424244);
    const dumped = JSON.stringify(events);
    expect(dumped).toContain("team desktop orphan sessions cleaned");
    expect(dumped).not.toContain("424242");
    expect(dumped).not.toContain("424243");
    expect(dumped).not.toContain("424244");
    const cleaned = events.find(
      (event) => event.message === "team desktop orphan sessions cleaned",
    );
    expect(cleaned).toMatchObject({ displayIndex: 123, sessions: 1, dbus: 1 });
  });

  it("refuses start when that display's CDP port is already taken", async () => {
    expect(teamDesktopPorts(111).cdp).toBe(9333);
    const displayIndex = 150;
    const port = teamDesktopPorts(displayIndex).cdp;
    const server = net.createServer();
    await listen(server, port);
    try {
      const command = vi.fn(async () => 0);
      const host = createLinuxTeamDesktopHost({ command, orphans: quietOrphans() });
      await expect(host.startWindow(displayIndex, "not-used")).rejects.toThrow(
        teamDesktopCdpBusyMessage(displayIndex),
      );
      expect(command).not.toHaveBeenCalled();
      await host.startWindow(149, "not-used");
      expect(command).toHaveBeenCalledWith(START_WINDOW_BIN, ["149", "not-used"], 20_000);
    } finally {
      await closeServer(server);
    }
  });
});

describe.skipIf(process.platform !== "linux")("team desktop orphan processes", () => {
  it("stop leaves no DISPLAY or sand-window process, and five cycles do not accumulate", async () => {
    const displayIndex = 141;
    const host = createLinuxTeamDesktopHost({ command: async () => 0 });
    const counts: number[] = [];
    for (let cycle = 0; cycle < 5; cycle += 1) {
      const session = await spawnSession(displayIndex, false);
      const dbus = await spawnDbus(displayIndex);
      await waitForSession(session.pid, displayIndex);
      await waitForDbus(dbus);
      expect(await boundProcessCount(displayIndex)).toBeGreaterThan(0);
      await host.stopWindow(displayIndex);
      counts.push(await waitForBound(displayIndex, 0));
      killTree(session.pid);
      killTree(dbus);
    }
    expect(counts).toEqual([0, 0, 0, 0, 0]);
    expect(await boundProcessCount(displayIndex)).toBe(0);
  }, 60_000);

  it("leaves a seat and a live Xvfb session while cleaning the orphan beside it", async () => {
    const displayIndex = 144;
    const seat = await spawnSession(20, false);
    const orphan = await spawnSession(displayIndex, false);
    const orphanDbus = await spawnDbus(displayIndex);
    await waitForSession(seat.pid, 20);
    await waitForSession(orphan.pid, displayIndex);
    await waitForDbus(orphanDbus);
    await delay(80);
    const live = await spawnSession(displayIndex, true);
    await waitForSession(live.pid, displayIndex);
    await delay(80);
    const liveDbus = await spawnDbus(displayIndex);
    await waitForDbus(liveDbus);

    const table = await readTeamDesktopProcTable();
    const orphanStart = startOf(table, orphan.pid);
    const liveStart = startOf(table, live.pid);
    const orphanDbusStart = startOf(table, orphanDbus);
    const liveDbusStart = startOf(table, liveDbus);
    expect(orphanStart).toBeLessThan(liveStart);
    expect(orphanDbusStart).toBeGreaterThanOrEqual(orphanStart);
    expect(orphanDbusStart).toBeLessThan(liveStart);
    expect(liveDbusStart).toBeGreaterThanOrEqual(liveStart);

    const host = createLinuxTeamDesktopHost({ command: async () => 0 });
    await host.cleanOrphans();

    await waitUntil(async () => !(await pidAlive(orphan.pid)) && !(await pidAlive(orphanDbus)));
    expect(await pidAlive(seat.pid)).toBe(true);
    expect(await pidAlive(live.pid)).toBe(true);
    expect(await pidAlive(liveDbus)).toBe(true);
    expect(await boundProcessCount(20)).toBeGreaterThan(0);
    const liveStill = (await readTeamDesktopProcTable()).filter((proc) => proc.sid === live.pid);
    expect(liveStill.some((proc) => proc.argv.includes(`:${displayIndex}`))).toBe(true);
  }, 60_000);
});

async function listen(server: net.Server, port: number) {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
}

async function closeServer(server: net.Server) {
  if (!server.listening) return;
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

function killTree(pid: number) {
  if (!Number.isInteger(pid) || pid <= 1) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {}
  try {
    process.kill(pid, "SIGKILL");
  } catch {}
}

function fixtureEnv(displayIndex: number): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: "/tmp",
    DISPLAY: `:${displayIndex}`,
  };
}

async function spawnSession(displayIndex: number, xvfb: boolean): Promise<{ pid: number }> {
  const dir = await mkdtemp(path.join(tmpdir(), "team-desktop-orphan-"));
  const script = path.join(dir, "start-desktop.sh");
  const lines = [
    "#!/bin/bash",
    `bash -c 'while true; do sleep 30; done' box-bounded-log --run /tmp/sand-window-${displayIndex}/start-desktop.log &`,
  ];
  if (xvfb) {
    lines.push(`bash -c 'while true; do sleep 30; done' Xvfb :${displayIndex} &`);
  }
  lines.push("tail -f /dev/null &", "wait");
  await writeFile(script, `${lines.join("\n")}\n`);
  const child = spawn("bash", [script], {
    detached: true,
    stdio: "ignore",
    env: fixtureEnv(displayIndex),
  });
  child.unref();
  if (!child.pid) throw new Error("session fixture did not start");
  tracked.add(child.pid);
  child.once("exit", () => {
    rm(dir, { recursive: true, force: true }).catch(() => {});
  });
  return { pid: child.pid };
}

async function spawnDbus(displayIndex: number): Promise<number> {
  const child = spawn("bash", ["-c", "exec -a dbus-daemon sleep 400"], {
    detached: true,
    stdio: "ignore",
    env: fixtureEnv(displayIndex),
  });
  child.unref();
  if (!child.pid) throw new Error("dbus fixture did not start");
  tracked.add(child.pid);
  return child.pid;
}

async function waitForSession(pid: number, displayIndex: number): Promise<void> {
  const marker = `/tmp/sand-window-${displayIndex}/`;
  await waitUntil(async () => {
    const table = await readTeamDesktopProcTable();
    const leader = table.find((proc) => proc.pid === pid);
    if (!leader || leader.sid !== pid || leader.pgid !== pid) return false;
    const members = table.filter((proc) => proc.sid === pid);
    const log = members.some((proc) => proc.argv.some((arg) => arg.includes(marker)));
    const waiting = members.some((proc) =>
      proc.argv.some((arg) => arg === "tail" || arg.endsWith("/tail")),
    );
    return log && waiting;
  });
}

async function waitForDbus(pid: number): Promise<void> {
  await waitUntil(async () => {
    const table = await readTeamDesktopProcTable();
    const found = table.find((proc) => proc.pid === pid);
    const name = found?.argv[0] ?? "";
    return name === "dbus-daemon" || name.endsWith("/dbus-daemon");
  });
}

function startOf(table: readonly TeamDesktopProc[], pid: number): number {
  const found = table.find((proc) => proc.pid === pid);
  if (!found) throw new Error(`fixture ${pid} is not in the process table`);
  return found.startTicks;
}

async function boundProcessCount(displayIndex: number): Promise<number> {
  const marker = `/tmp/sand-window-${displayIndex}/`;
  const exact = `DISPLAY=:${displayIndex}`;
  const dotted = `DISPLAY=:${displayIndex}.`;
  let names: string[];
  try {
    names = await readdir("/proc");
  } catch {
    return 0;
  }
  let count = 0;
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const [stat, cmd, env] = await Promise.all([
        readFile(`/proc/${name}/stat`, "utf8"),
        readFile(`/proc/${name}/cmdline`, "utf8"),
        readFile(`/proc/${name}/environ`, "utf8"),
      ]);
      if (zombie(stat)) continue;
      const display = env.split("\0").some((entry) => entry === exact || entry.startsWith(dotted));
      if (display || cmd.includes(marker)) count += 1;
    } catch {
      // The process exited while it was being read.
    }
  }
  return count;
}

function zombie(stat: string): boolean {
  const close = stat.lastIndexOf(")");
  if (close < 0) return false;
  return stat
    .slice(close + 1)
    .trim()
    .startsWith("Z");
}

async function waitForBound(displayIndex: number, expected: number): Promise<number> {
  let count = await boundProcessCount(displayIndex);
  const start = Date.now();
  while (count !== expected && Date.now() - start < 2_000) {
    await delay(20);
    count = await boundProcessCount(displayIndex);
  }
  if (count !== expected) {
    throw new Error(`display ${displayIndex} still has ${count} processes`);
  }
  return count;
}

async function pidAlive(pid: number): Promise<boolean> {
  const table = await readTeamDesktopProcTable();
  return table.some((proc) => proc.pid === pid);
}

async function waitUntil(check: () => Promise<boolean>): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < 3_000) {
    if (await check()) return;
    await delay(20);
  }
  throw new Error("fixture process did not appear");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
