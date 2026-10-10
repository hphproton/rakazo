import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ProcessEvent } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it } from "vitest";
import { teamDesktopSpawnArgv } from "./sand-desktop-hands.js";
import type { SandExecRequest, SandHost } from "./sand-host.js";
import { SAND_TEAM_BROWSER } from "./sand-host.js";
import { teamDesktopCdpBusyMessage, teamDesktopPorts } from "./team-desktop.js";
import {
  createTeamDesktopChromeStarter,
  ensureTeamDesktopChrome,
  launchTeamDesktopChrome,
  teamDesktopCdpStatus,
  teamDesktopChromeArgv,
  teamDesktopChromeProfile,
} from "./team-desktop-chrome.js";
import { createLinuxTeamDesktopHost, START_WINDOW_BIN } from "./team-desktop-host.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("team desktop chrome owner", () => {
  it("launches box-chrome with the Fork-N profile and a loopback debugger", () => {
    expect(teamDesktopChromeProfile(101)).toBe("/home/box/chrome-profile/Fork-101");
    expect(teamDesktopChromeArgv(101)).toEqual([
      SAND_TEAM_BROWSER,
      "--user-data-dir=/home/box/chrome-profile/Fork-101",
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=9323",
    ]);
    expect(teamDesktopSpawnArgv(teamDesktopChromeArgv(111))[4]).toBe("2.4");
  });

  it("accepts only this display's Chrome on the loopback listen socket", async () => {
    const root = await tempDir();
    const displayIndex = 101;
    const port = teamDesktopPorts(displayIndex).cdp;
    expect(await teamDesktopCdpStatus(displayIndex, root)).toBe("absent");
    expect(await teamDesktopCdpStatus(displayIndex, path.join(root, "missing"))).toBe("foreign");

    await writeListen(root, port, "42");
    await writeProc(root, "4242", {
      argv: chromeArgv(displayIndex),
      display: ":101",
      sockets: ["42"],
    });
    expect(await teamDesktopCdpStatus(displayIndex, root)).toBe("owned");

    await writeProc(root, "4242", {
      argv: [
        "/opt/google/chrome/chrome",
        "--user-data-dir",
        teamDesktopChromeProfile(displayIndex),
        "--remote-debugging-address",
        "127.0.0.1",
        "--remote-debugging-port=9323",
      ],
      sockets: ["42"],
    });
    expect(await teamDesktopCdpStatus(displayIndex, root)).toBe("owned");

    await writeProc(root, "4242", {
      argv: chromeArgv(displayIndex),
      display: ":101",
      exe: "/usr/local/bin/box-chrome",
      sockets: ["99"],
    });
    await writeProc(root, "7", {
      argv: ["socat", "TCP-LISTEN:9323"],
      exe: "/usr/bin/socat",
      sockets: ["42"],
    });
    expect(await teamDesktopCdpStatus(displayIndex, root)).toBe("foreign");
  });

  it("rejects another display, another profile, a renderer, and a non-loopback bind", async () => {
    const root = await tempDir();
    const displayIndex = 101;
    const port = teamDesktopPorts(displayIndex).cdp;
    await writeListen(root, port, "42");

    await writeProc(root, "20", {
      argv: chromeArgv(20),
      display: ":20",
      sockets: ["42"],
    });
    expect(await teamDesktopCdpStatus(displayIndex, root)).toBe("foreign");

    await writeProc(root, "20", {
      argv: [],
      cmdline: measuredCmdline("Fork-101"),
      environ: clobberedEnviron(),
      sockets: ["99"],
    });
    expect(await teamDesktopCdpStatus(displayIndex, root)).toBe("foreign");

    await writeProc(root, "20", {
      argv: chromeArgv(displayIndex, "/home/box/chrome-profile/Fork-1010"),
      display: ":101",
      sockets: ["42"],
    });
    expect(await teamDesktopCdpStatus(displayIndex, root)).toBe("foreign");

    await writeProc(root, "20", {
      argv: chromeArgv(displayIndex, "/tmp/Fork-101"),
      display: ":1010",
      sockets: ["42"],
    });
    expect(await teamDesktopCdpStatus(displayIndex, root)).toBe("foreign");

    await writeProc(root, "20", {
      argv: ["--type=renderer", ...chromeArgv(displayIndex)],
      display: ":101",
      sockets: ["42"],
    });
    expect(await teamDesktopCdpStatus(displayIndex, root)).toBe("foreign");

    await writeListen(root, port, "42", "0.0.0.0");
    await writeProc(root, "20", {
      argv: chromeArgv(displayIndex),
      sockets: ["42"],
    });
    expect(await teamDesktopCdpStatus(displayIndex, root)).toBe("foreign");

    await writeListen(root, port, "42");
    await writeProc(root, "20", {
      argv: [
        "/opt/google/chrome/chrome",
        "--user-data-dir=/home/box/chrome-profile/Fork-101",
        "--remote-debugging-address=0.0.0.0",
        "--remote-debugging-port=9323",
      ],
      sockets: ["42"],
    });
    expect(await teamDesktopCdpStatus(displayIndex, root)).toBe("foreign");

    await writeProc(root, "20", {
      argv: [
        "/opt/google/chrome/chrome",
        "--user-data-dir=/home/box/chrome-profile/Fork-101",
        "--remote-debugging-address",
        "localhost",
        "--remote-debugging-port=9323",
      ],
      sockets: ["42"],
    });
    expect(await teamDesktopCdpStatus(displayIndex, root)).toBe("foreign");

    await writeProc(root, "20", {
      argv: [
        "/opt/google/chrome/chrome",
        "--user-data-dir=/home/box/chrome-profile/Fork-101",
        "--remote-debugging-port=9323",
      ],
      sockets: ["42"],
    });
    expect(await teamDesktopCdpStatus(displayIndex, root)).toBe("foreign");

    await writeProc(root, "20", {
      argv: chromeArgv(displayIndex),
      exe: "/bin/bash",
      sockets: ["42"],
    });
    expect(await teamDesktopCdpStatus(displayIndex, root)).toBe("foreign");
  });

  it("accepts Chrome whose environ was overwritten and has no DISPLAY", async () => {
    const root = await tempDir();
    const displayIndex = 101;
    const port = teamDesktopPorts(displayIndex).cdp;
    const environ = clobberedEnviron();
    expect(environ.length).toBe(10194);
    expect(environ.includes(0)).toBe(false);
    expect(environ.includes(Buffer.from("DISPLAY="))).toBe(false);
    await writeListen(root, port, "42");
    await writeProc(root, "4097904", {
      argv: [],
      cmdline: measuredCmdline("Fork-101"),
      environ,
      exe: "/opt/google/chrome/chrome",
      sockets: ["42"],
    });
    expect(await teamDesktopCdpStatus(displayIndex, root)).toBe("owned");

    await writeProc(root, "4097904", {
      argv: [],
      cmdline: measuredCmdline("Fork-20", 9242),
      environ,
      exe: "/opt/google/chrome/chrome",
      sockets: ["42"],
    });
    expect(await teamDesktopCdpStatus(displayIndex, root)).toBe("foreign");
  });

  it("does not launch over a foreign listener or a Chrome that is already starting", async () => {
    const root = await tempDir();
    const displayIndex = 101;
    const port = teamDesktopPorts(displayIndex).cdp;
    const launches: string[] = [];
    const launch = async () => {
      launches.push("go");
    };

    await writeListen(root, port, "7");
    await writeProc(root, "7", {
      argv: ["socat", "TCP-LISTEN:9323,fork"],
      exe: "/usr/bin/socat",
      sockets: ["7"],
    });
    expect(await ensureTeamDesktopChrome({ displayIndex, procRoot: root, launch })).toBe("foreign");
    expect(launches).toEqual([]);

    await rm(path.join(root, "net"), { recursive: true, force: true });
    await writeProc(root, "8", {
      argv: chromeArgv(displayIndex),
      display: ":101",
    });
    expect(await ensureTeamDesktopChrome({ displayIndex, procRoot: root, launch })).toBe(
      "starting",
    );
    expect(launches).toEqual([]);

    await rm(path.join(root, "8"), { recursive: true, force: true });
    expect(await ensureTeamDesktopChrome({ displayIndex, procRoot: root, launch })).toBe("absent");
    expect(launches).toEqual(["go"]);
  });

  it("execs detached box-chrome and skips the exec when this Chrome already owns the port", async () => {
    const root = await tempDir();
    const displayIndex = 101;
    const host = new RecordingHost();
    await launchTeamDesktopChrome(host, "bot-a", displayIndex, new AbortController().signal);
    expect(host.requests).toEqual([
      expect.objectContaining({
        argv: teamDesktopSpawnArgv(teamDesktopChromeArgv(displayIndex)),
        cwd: "/workspace",
        env: { BROWSER: SAND_TEAM_BROWSER },
        timeoutMs: 15_000,
      }),
    ]);
    expect(host.requests[0]?.env).not.toHaveProperty("DISPLAY");

    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push(String(input));
      const body = framedJson(init?.body);
      expect(body.command).toBe("sh");
      expect(body.args).toContain(SAND_TEAM_BROWSER);
      expect(body.args).toContain("--user-data-dir=/home/box/chrome-profile/Fork-101");
      expect(body.args).toContain("--remote-debugging-address=127.0.0.1");
      expect(body.args).toContain("--remote-debugging-port=9323");
      expect(body.cwd).toBe("/workspace");
      expect(body.environment).toEqual({ BROWSER: SAND_TEAM_BROWSER });
      const headers = new Headers(init?.headers);
      expect(headers.get("x-sand-display")).toBe("101");
      expect(headers.get("x-sand-window-owner")).toBe("fixture-owner-token");
      return new Response(
        Buffer.concat([
          frame(0, { stdoutEvent: { data: "" } }),
          frame(0, { exitEvent: { exitCode: 0 } }),
          frame(2, {}),
        ]),
      );
    };
    const start = createTeamDesktopChromeStarter({
      token: "test-sand-token",
      procRoot: root,
      fetch: fetchImpl,
    });
    await start({ botId: "bot-a", displayIndex, ownerToken: "fixture-owner-token" });
    expect(calls).toEqual(["http://127.0.0.1:1339/agent.v1.ControlService/Exec"]);

    await writeListen(root, teamDesktopPorts(displayIndex).cdp, "42");
    await writeProc(root, "4242", {
      argv: chromeArgv(displayIndex),
      display: ":101",
      sockets: ["42"],
    });
    calls.length = 0;
    await start({ botId: "bot-a", displayIndex, ownerToken: "fixture-owner-token" });
    expect(calls).toEqual([]);
  });

  it("lets the window start when this desktop's Chrome already holds the CDP port", async () => {
    const root = await tempDir();
    const displayIndex = 148;
    const port = teamDesktopPorts(displayIndex).cdp;
    await writeListen(root, port, "42");
    await writeProc(root, "4242", {
      argv: chromeArgv(displayIndex),
      display: ":148",
      sockets: ["42"],
    });
    const server = net.createServer();
    await listen(server, port);
    const calls: string[] = [];
    try {
      const host = createLinuxTeamDesktopHost({
        command: async (file, args) => {
          calls.push([file, ...args].join(" "));
          return 0;
        },
        orphans: {
          list: async () => [],
          signal() {},
          alive: () => false,
          sleep: async () => undefined,
          uid: () => 1,
        },
        procRoot: root,
      });
      await host.startWindow(displayIndex, "not-used");
      expect(calls).toEqual([`${START_WINDOW_BIN} ${displayIndex} not-used`]);
    } finally {
      await closeServer(server);
    }
  });

  it("still refuses a window start when a foreign listener holds the CDP port", async () => {
    const root = await tempDir();
    const displayIndex = 147;
    const port = teamDesktopPorts(displayIndex).cdp;
    await writeListen(root, port, "7");
    await writeProc(root, "7", {
      argv: ["socat", "TCP-LISTEN:9369"],
      exe: "/usr/bin/socat",
      sockets: ["7"],
    });
    const server = net.createServer();
    await listen(server, port);
    const calls: string[] = [];
    try {
      const host = createLinuxTeamDesktopHost({
        command: async () => {
          calls.push("start");
          return 0;
        },
        orphans: {
          list: async () => [],
          signal() {},
          alive: () => false,
          sleep: async () => undefined,
          uid: () => 1,
        },
        procRoot: root,
      });
      await expect(host.startWindow(displayIndex, "not-used")).rejects.toThrow(
        teamDesktopCdpBusyMessage(displayIndex),
      );
      expect(calls).toEqual([]);
    } finally {
      await closeServer(server);
    }
  });
});

class RecordingHost implements SandHost {
  readonly requests: SandExecRequest[] = [];

  async capabilities() {
    return { computerUseSupported: true };
  }

  async *exec(
    _agentId: string,
    request: SandExecRequest,
    _signal: AbortSignal,
  ): AsyncIterable<ProcessEvent> {
    this.requests.push(request);
    yield { type: "exit", code: 0 };
  }

  async listDirectory() {
    return [];
  }

  async readFile() {
    return new Uint8Array();
  }

  async writeFile() {}

  async computerUse() {
    return {};
  }

  screenUrl() {
    return null;
  }
}

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "rakazo-cdp-owner-"));
  dirs.push(dir);
  return dir;
}

function chromeArgv(
  displayIndex: number,
  profile = `/home/box/chrome-profile/Fork-${displayIndex}`,
): string[] {
  return [
    "/opt/google/chrome/chrome",
    `--user-data-dir=${profile}`,
    "--remote-debugging-address=127.0.0.1",
    `--remote-debugging-port=${9222 + displayIndex}`,
  ];
}

function clobberedEnviron(): Buffer {
  return Buffer.alloc(10194, 0x78);
}

function measuredCmdline(fork: string, port = 9222 + Number(fork.slice("Fork-".length))): Buffer {
  return Buffer.from(
    `/opt/google/chrome/chrome --user-data-dir=/home/box/chrome-profile/${fork} --remote-debugging-port=${port} --remote-debugging-address=127.0.0.1`,
  );
}

async function writeProc(
  root: string,
  pid: string,
  opts: {
    argv: string[];
    display?: string;
    exe?: string;
    sockets?: string[];
    cmdline?: Buffer;
    environ?: Buffer;
  },
): Promise<void> {
  const dir = path.join(root, pid);
  await mkdir(path.join(dir, "fd"), { recursive: true });
  const cmdline = opts.cmdline ?? Buffer.from(`${opts.argv.join("\0")}\0`);
  await writeFile(path.join(dir, "cmdline"), cmdline);
  if (opts.environ) await writeFile(path.join(dir, "environ"), opts.environ);
  else if (opts.display) await writeFile(path.join(dir, "environ"), `DISPLAY=${opts.display}\0`);
  const exe = path.join(dir, "exe");
  await rm(exe, { force: true });
  await symlink(opts.exe ?? "/opt/google/chrome/chrome", exe);
  for (const [index, inode] of (opts.sockets ?? []).entries()) {
    const fd = path.join(dir, "fd", String(index));
    await rm(fd, { force: true });
    await symlink(`socket:[${inode}]`, fd);
  }
}

async function writeListen(
  root: string,
  port: number,
  inode: string,
  addr: "127.0.0.1" | "0.0.0.0" = "127.0.0.1",
): Promise<void> {
  const hexAddr = addr === "127.0.0.1" ? "0100007F" : "00000000";
  const hexPort = port.toString(16).toUpperCase();
  await mkdir(path.join(root, "net"), { recursive: true });
  const line = `   0: ${hexAddr}:${hexPort} 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 ${inode} 1 0000000000000000 100 0 0 10 0`;
  await writeFile(
    path.join(root, "net", "tcp"),
    `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n${line}\n`,
  );
}

function frame(flags: number, value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(5);
  header[0] = flags;
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

function framedJson(body: BodyInit | null | undefined): {
  command?: string;
  args?: string[];
  cwd?: string;
  environment?: Record<string, string>;
} {
  const bytes = Buffer.from(body as Uint8Array);
  const length = bytes.readUInt32BE(1);
  return JSON.parse(bytes.subarray(5, 5 + length).toString("utf8")) as {
    command?: string;
    args?: string[];
    cwd?: string;
    environment?: Record<string, string>;
  };
}

function listen(server: net.Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
}

function closeServer(server: net.Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}
