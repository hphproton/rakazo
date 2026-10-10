import { readdir, readFile, readlink } from "node:fs/promises";
import { teamDesktopSpawnArgv } from "./sand-desktop-hands.js";
import type { SandHost } from "./sand-host.js";
import { ConnectSandHost, SAND_TEAM_BROWSER, sandTeamExecEnv } from "./sand-host.js";
import { assertTeamDesktopIndex, teamDesktopPorts } from "./team-desktop.js";

/** Pod workspace sand exec already uses. Importing it from the provider would cycle. */
const CHROME_LAUNCH_CWD = "/workspace";
const BROWSER_LAUNCH_TIMEOUT_MS = 15_000;

const NOT_CHROME = new Set([
  "bash",
  "dash",
  "sh",
  "timeout",
  "socat",
  "python",
  "python3",
  "nc",
  "ncat",
  "busybox",
]);

/**
 * `owned` is this display's Chrome listening on 127.0.0.1:9222+N.
 * `foreign` is any other listener, or a process table we cannot read.
 * `starting` is that Chrome without the listen socket yet.
 * `absent` means nothing of ours is up and nothing else holds the port.
 */
export type TeamDesktopCdpStatus = "owned" | "foreign" | "starting" | "absent";

/** Chrome profile for display N. Other Fork roots are leftovers, not this browser. */
export function teamDesktopChromeProfile(displayIndex: number): string {
  assertTeamDesktopIndex(displayIndex);
  return `/home/box/chrome-profile/Fork-${displayIndex}`;
}

/**
 * Seat browser plus the Fork-N profile and loopback debugger.
 * `box-chrome` is what a Grok seat launches. These flags are the profile and
 * the loopback port that browser binds. No other stock Chrome flags are added.
 */
export function teamDesktopChromeArgv(displayIndex: number): string[] {
  const port = teamDesktopPorts(displayIndex).cdp;
  return [
    SAND_TEAM_BROWSER,
    `--user-data-dir=${teamDesktopChromeProfile(displayIndex)}`,
    "--remote-debugging-address=127.0.0.1",
    `--remote-debugging-port=${port}`,
  ];
}

export function teamDesktopCdpRefusedMessage(displayIndex: number): string {
  const port = teamDesktopPorts(displayIndex).cdp;
  return `Page browser refused: CDP port ${port} is not this desktop's Chrome.`;
}

/**
 * Who holds the listen socket on 127.0.0.1:9222+N.
 * Owned means a Chrome whose DISPLAY is :N (or :N.0) and whose --user-data-dir
 * is the Fork-N profile. Another display's Chrome, a non-Chrome process, or a
 * non-loopback bind is not owned.
 */
export async function teamDesktopCdpStatus(
  displayIndex: number,
  procRoot = "/proc",
): Promise<TeamDesktopCdpStatus> {
  const port = teamDesktopPorts(displayIndex).cdp;
  const profile = teamDesktopChromeProfile(displayIndex);
  let names: string[];
  try {
    names = await readdir(procRoot);
  } catch {
    return "foreign";
  }
  const listeners = parseTcpListeners(await readText(procRoot, "net/tcp"), port);
  const browsers: string[] = [];
  for (const pid of names) {
    if (!/^\d+$/.test(pid)) continue;
    if (await browserMatches(procRoot, pid, profile, displayIndex)) browsers.push(pid);
  }
  for (const pid of browsers) {
    const sockets = await socketInodes(procRoot, pid);
    for (const inode of listeners.loopback) {
      if (sockets.has(inode)) return "owned";
    }
  }
  if (listeners.any) return "foreign";
  if (browsers.length > 0) return "starting";
  return "absent";
}

/** Launch only when the port is empty. A foreign listener is left untouched. */
export async function ensureTeamDesktopChrome(input: {
  displayIndex: number;
  procRoot?: string;
  launch: () => Promise<void>;
}): Promise<TeamDesktopCdpStatus> {
  const status = await teamDesktopCdpStatus(input.displayIndex, input.procRoot);
  if (status !== "absent") return status;
  await input.launch();
  return teamDesktopCdpStatus(input.displayIndex, input.procRoot);
}

/** Detached box-chrome on this display. The exec daemon already has DISPLAY=:N. */
export async function launchTeamDesktopChrome(
  host: SandHost,
  agentId: string,
  displayIndex: number,
  signal: AbortSignal,
): Promise<void> {
  let code = 0;
  for await (const event of host.exec(
    agentId,
    {
      argv: teamDesktopSpawnArgv(teamDesktopChromeArgv(displayIndex)),
      cwd: CHROME_LAUNCH_CWD,
      env: sandTeamExecEnv(undefined),
      timeoutMs: BROWSER_LAUNCH_TIMEOUT_MS,
    },
    signal,
  )) {
    if (event.type === "exit") code = event.code;
  }
  if (code !== 0) throw new Error("could not start browser");
}

/** Wake hook. Reads this machine's process table and starts box-chrome when the port is empty. */
export function createTeamDesktopChromeStarter(
  opts: {
    token?: string;
    /** Tests point this at a fake process table. Production reads /proc. */
    procRoot?: string;
    /** Tests substitute fetch. Production uses the platform fetch. */
    fetch?: typeof fetch;
  } = {},
): (desktop: { botId: string; displayIndex: number; ownerToken: string }) => Promise<void> {
  return async (desktop) => {
    const host = new ConnectSandHost({
      token: opts.token,
      fetch: opts.fetch,
      display: { displayIndex: desktop.displayIndex, ownerToken: desktop.ownerToken },
    });
    await ensureTeamDesktopChrome({
      displayIndex: desktop.displayIndex,
      procRoot: opts.procRoot,
      launch: () =>
        launchTeamDesktopChrome(
          host,
          desktop.botId,
          desktop.displayIndex,
          AbortSignal.timeout(BROWSER_LAUNCH_TIMEOUT_MS),
        ),
    });
  };
}

function parseTcpListeners(text: string, port: number): { loopback: Set<string>; any: boolean } {
  const loopback = new Set<string>();
  let any = false;
  for (const line of text.split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 10 || fields[3]?.toUpperCase() !== "0A") continue;
    const local = fields[1] ?? "";
    const colon = local.lastIndexOf(":");
    if (colon <= 0) continue;
    const parsed = Number.parseInt(local.slice(colon + 1), 16);
    if (parsed !== port) continue;
    const inode = fields[9] ?? "";
    if (!/^\d+$/.test(inode)) continue;
    any = true;
    if (local.slice(0, colon).toUpperCase() === "0100007F") loopback.add(inode);
  }
  return { loopback, any };
}

async function browserMatches(
  procRoot: string,
  pid: string,
  profile: string,
  displayIndex: number,
): Promise<boolean> {
  const args = await commandArgs(procRoot, pid);
  if (!args || args.length === 0 || isRenderer(args)) return false;
  if (!sameProfile(userDataDir(args), profile)) return false;
  if (!displayMatches(await readDisplay(procRoot, pid), displayIndex)) return false;
  return isChromeExecutable(await readExe(procRoot, pid), args[0] ?? "");
}

function isRenderer(args: readonly string[]): boolean {
  return args.some((arg) => arg === "--type" || arg.startsWith("--type="));
}

function userDataDir(args: readonly string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "--user-data-dir") return args[index + 1];
    if (arg.startsWith("--user-data-dir=")) return arg.slice("--user-data-dir=".length);
  }
  return undefined;
}

function sameProfile(actual: string | undefined, expected: string): boolean {
  if (!actual) return false;
  const stripped = actual.length > 1 && actual.endsWith("/") ? actual.slice(0, -1) : actual;
  return stripped === expected;
}

function displayMatches(value: string | undefined, displayIndex: number): boolean {
  return value === `:${displayIndex}` || value === `:${displayIndex}.0`;
}

function isChromeExecutable(exe: string | undefined, argv0: string): boolean {
  const names = [exe, argv0]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .map(baseName);
  if (names.some((name) => NOT_CHROME.has(name))) return false;
  return names.some((name) => looksLikeChrome(name));
}

function looksLikeChrome(name: string): boolean {
  if (name.includes("crashpad") || name.includes("sandbox")) return false;
  return (
    name === "box-chrome" ||
    name === "chrome" ||
    name === "chromium" ||
    name === "chromium-browser" ||
    name.startsWith("google-chrome") ||
    name.startsWith("chromium")
  );
}

function baseName(value: string): string {
  const slash = Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"));
  const name = slash >= 0 ? value.slice(slash + 1) : value;
  return name.endsWith(" (deleted)") ? name.slice(0, -" (deleted)".length) : name;
}

async function commandArgs(procRoot: string, pid: string): Promise<string[] | undefined> {
  const raw = await readBytes(procRoot, pid, "cmdline");
  if (!raw) return undefined;
  if (raw.includes(0)) {
    const parts = raw.toString("utf8").split("\0");
    if (parts.at(-1) === "") parts.pop();
    return parts.filter((part) => part.length > 0);
  }
  const text = raw.toString("utf8").trim();
  return text ? text.split(/\s+/) : [];
}

async function readDisplay(procRoot: string, pid: string): Promise<string | undefined> {
  const raw = await readBytes(procRoot, pid, "environ");
  if (!raw) return undefined;
  for (const entry of raw.toString("utf8").split("\0")) {
    if (!entry.startsWith("DISPLAY=")) continue;
    return entry.slice("DISPLAY=".length);
  }
  return undefined;
}

async function readExe(procRoot: string, pid: string): Promise<string | undefined> {
  try {
    return await readlink(`${procRoot}/${pid}/exe`);
  } catch {
    return undefined;
  }
}

async function socketInodes(procRoot: string, pid: string): Promise<Set<string>> {
  const inodes = new Set<string>();
  let fds: string[];
  try {
    fds = await readdir(`${procRoot}/${pid}/fd`);
  } catch {
    return inodes;
  }
  for (const fd of fds) {
    try {
      const link = await readlink(`${procRoot}/${pid}/fd/${fd}`);
      if (link.startsWith("socket:[") && link.endsWith("]")) {
        inodes.add(link.slice("socket:[".length, -1));
      }
    } catch {}
  }
  return inodes;
}

async function readText(procRoot: string, name: string): Promise<string> {
  try {
    return await readFile(`${procRoot}/${name}`, "utf8");
  } catch {
    return "";
  }
}

async function readBytes(procRoot: string, pid: string, name: string): Promise<Buffer | undefined> {
  try {
    return await readFile(`${procRoot}/${pid}/${name}`);
  } catch {
    return undefined;
  }
}
