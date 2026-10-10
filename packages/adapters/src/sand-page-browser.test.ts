import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { pageBrowserFallback, runSandPageBrowser } from "./sand-page-browser.js";
import { teamDesktopPorts } from "./team-desktop.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("sand page browser", () => {
  it("runs the helper with this desktop's display and CDP port", async () => {
    const dir = await tempDir();
    const displayIndex = 121;
    await ownedChrome(dir, displayIndex);
    const script = path.join(dir, "helper.py");
    await writeFile(
      script,
      [
        "import json, os",
        "print(json.dumps({",
        '  "ok": True,',
        '  "display": os.environ.get("DISPLAY"),',
        '  "port": os.environ.get("RAKAZO_CDP_PORT"),',
        '  "path": os.environ.get("PATH"),',
        "}))",
        "",
      ].join("\n"),
    );
    const result = await runSandPageBrowser({
      displayIndex,
      command: { command: "snapshot" },
      signal: new AbortController().signal,
      scriptPath: script,
      procRoot: dir,
      waitMs: 0,
    });
    expect(result).toMatchObject({
      ok: true,
      display: ":121",
      port: "9343",
      path: process.env.PATH ?? "/usr/bin:/bin",
    });
  });

  it("returns the desktop fallback when the helper cannot attach", async () => {
    const dir = await tempDir();
    await ownedChrome(dir, 101);
    const missing = await runSandPageBrowser({
      displayIndex: 101,
      command: { command: "act", actions: [{ kind: "click", ref: "e1" }] },
      signal: new AbortController().signal,
      scriptPath: path.join(dir, "missing"),
      procRoot: dir,
      waitMs: 0,
    });
    expect(missing).toEqual(pageBrowserFallback("act"));
    expect(missing.uncertain).toBe(true);
  });

  it("refuses a foreign listener and does not attach", async () => {
    const dir = await tempDir();
    const displayIndex = 101;
    const port = teamDesktopPorts(displayIndex).cdp;
    const { script, marker } = await markerScript(dir);
    await writeListen(dir, port, "7");
    await writeProc(dir, "7", {
      argv: ["socat", "TCP-LISTEN:9323,bind=127.0.0.1,fork", "TCP:127.0.0.1:9242"],
      exe: "/usr/bin/socat",
      sockets: ["7"],
    });
    const launches: number[] = [];
    const refused = await runSandPageBrowser({
      displayIndex,
      command: { command: "act", actions: [{ kind: "click", ref: "e1" }] },
      signal: new AbortController().signal,
      scriptPath: script,
      procRoot: dir,
      waitMs: 0,
      launchChrome: (index) => {
        launches.push(index);
        return Promise.resolve();
      },
    });
    expect(refused).toEqual({
      ok: false,
      fallback: "computer_act",
      error: `Page browser refused: CDP port ${port} is not this desktop's Chrome.`,
      uncertain: true,
    });
    expect(launches).toEqual([]);
    expect(await exists(marker)).toBe(false);

    await writeProc(dir, "20", {
      argv: chromeArgv(20),
      display: ":20",
      sockets: ["7"],
    });
    const otherDisplay = await runSandPageBrowser({
      displayIndex,
      command: { command: "snapshot" },
      signal: new AbortController().signal,
      scriptPath: script,
      procRoot: dir,
      waitMs: 0,
    });
    expect(otherDisplay.ok).toBe(false);
    expect(otherDisplay.error).toBe(
      "Page browser refused: CDP port 9323 is not this desktop's Chrome.",
    );
    expect(otherDisplay.uncertain).toBeUndefined();
    expect(await exists(marker)).toBe(false);
  });

  it("attaches when the listener is Chrome with a clobbered environment", async () => {
    const dir = await tempDir();
    const displayIndex = 101;
    const port = teamDesktopPorts(displayIndex).cdp;
    const { script, marker } = await markerScript(dir);
    await writeListen(dir, port, "8");
    const environ = Buffer.alloc(10194, 0x78);
    const cmdline = await readFile(titleFixture);
    expect(nulCount(cmdline)).toBe(1);
    expect(cmdline.at(-1)).toBe(0);
    expect(environ.length).toBe(10194);
    expect(environ.includes(0)).toBe(false);
    expect(environ.includes(Buffer.from("DISPLAY="))).toBe(false);
    await writeProc(dir, "4097904", {
      argv: [],
      cmdline,
      environ,
      exe: "/opt/google/chrome/chrome",
      sockets: ["8"],
    });
    const attached = await runSandPageBrowser({
      displayIndex,
      command: { command: "snapshot" },
      signal: new AbortController().signal,
      scriptPath: script,
      procRoot: dir,
      waitMs: 0,
    });
    expect(attached).toMatchObject({ ok: true });
    expect(await exists(marker)).toBe(true);

    await writeProc(dir, "4097904", {
      argv: [],
      cmdline: Buffer.from(cmdline.toString("utf8").replaceAll("Fork-101", "Fork-20")),
      environ,
      exe: "/opt/google/chrome/chrome",
      sockets: ["8"],
    });
    const otherFork = await runSandPageBrowser({
      displayIndex,
      command: { command: "snapshot" },
      signal: new AbortController().signal,
      scriptPath: script,
      procRoot: dir,
      waitMs: 0,
    });
    expect(otherFork.ok).toBe(false);
    expect(otherFork.error).toBe(
      "Page browser refused: CDP port 9323 is not this desktop's Chrome.",
    );
  });

  it("refuses a Chrome on the right port with the wrong profile", async () => {
    const dir = await tempDir();
    const displayIndex = 101;
    const { script, marker } = await markerScript(dir);
    await writeListen(dir, teamDesktopPorts(displayIndex).cdp, "8");
    await writeProc(dir, "8", {
      argv: chromeArgv(displayIndex, "/tmp/Fork-101"),
      sockets: ["8"],
    });
    const wrongProfile = await runSandPageBrowser({
      displayIndex,
      command: { command: "snapshot" },
      signal: new AbortController().signal,
      scriptPath: script,
      procRoot: dir,
      waitMs: 0,
    });
    expect(wrongProfile.ok).toBe(false);
    expect(await exists(marker)).toBe(false);
  });

  it("refuses a listener that is not bound to loopback", async () => {
    const dir = await tempDir();
    const displayIndex = 101;
    const { script, marker } = await markerScript(dir);
    await writeListen(dir, teamDesktopPorts(displayIndex).cdp, "9", "0.0.0.0");
    await writeProc(dir, "9", {
      argv: chromeArgv(displayIndex),
      display: ":101",
      sockets: ["9"],
    });
    const refused = await runSandPageBrowser({
      displayIndex,
      command: { command: "snapshot" },
      signal: new AbortController().signal,
      scriptPath: script,
      procRoot: dir,
      waitMs: 0,
    });
    expect(refused.ok).toBe(false);
    expect(refused.error).toBe("Page browser refused: CDP port 9323 is not this desktop's Chrome.");
    expect(await exists(marker)).toBe(false);
  });

  it("does not attach when Chrome fails to start", async () => {
    const dir = await tempDir();
    const { script, marker } = await markerScript(dir);
    const result = await runSandPageBrowser({
      displayIndex: 101,
      command: { command: "snapshot" },
      signal: new AbortController().signal,
      scriptPath: script,
      procRoot: dir,
      waitMs: 0,
      launchChrome: async () => {
        throw new Error("could not start browser");
      },
    });
    expect(result.ok).toBe(false);
    expect(result.fallback).toBe("computer_act");
    expect(result.error).toBe("Page browser refused: CDP port 9323 is not this desktop's Chrome.");
    expect(await exists(marker)).toBe(false);
  });

  it("starts box-chrome when the port is empty, then attaches only after it owns the port", async () => {
    const dir = await tempDir();
    const displayIndex = 101;
    const { script, marker } = await markerScript(dir);
    let launches = 0;
    const result = await runSandPageBrowser({
      displayIndex,
      command: { command: "snapshot" },
      signal: new AbortController().signal,
      scriptPath: script,
      procRoot: dir,
      waitMs: 0,
      launchChrome: async () => {
        launches += 1;
        await ownedChrome(dir, displayIndex);
      },
    });
    expect(launches).toBe(1);
    expect(result).toMatchObject({ ok: true });
    expect(await exists(marker)).toBe(true);
  });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "rakazo-page-browser-"));
  dirs.push(dir);
  return dir;
}

const titleFixture = fileURLToPath(
  new URL("./fixtures/chrome-fork-101-setproctitle.bin", import.meta.url),
);

function nulCount(bytes: Buffer): number {
  let count = 0;
  for (const byte of bytes) if (byte === 0) count += 1;
  return count;
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

async function ownedChrome(root: string, displayIndex: number): Promise<void> {
  const port = teamDesktopPorts(displayIndex).cdp;
  await writeListen(root, port, "42");
  await writeProc(root, "4242", {
    argv: chromeArgv(displayIndex),
    display: `:${displayIndex}`,
    sockets: ["42"],
  });
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

async function markerScript(dir: string): Promise<{ script: string; marker: string }> {
  const marker = path.join(dir, "ran");
  const script = path.join(dir, "helper.py");
  await writeFile(
    script,
    `open(${JSON.stringify(marker)}, "w").write("x")\nprint('{"ok": true}')\n`,
  );
  return { script, marker };
}

function exists(target: string): Promise<boolean> {
  return access(target).then(
    () => true,
    () => false,
  );
}
