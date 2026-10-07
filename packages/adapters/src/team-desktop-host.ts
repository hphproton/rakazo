import { spawn } from "node:child_process";
import { access, readdir, readlink, rm } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { getLogger } from "@rakazo/logging";
import {
  assertTeamDesktopIndex,
  isTeamDesktopTmpLeftover,
  TEAM_DESKTOP_FORK_ROOTS,
  type TeamDesktopHost,
  teamDesktopPorts,
  teamDesktopPurgePaths,
} from "./team-desktop.js";

export const START_WINDOW_BIN = "/usr/local/bin/start-window";
export const STOP_WINDOW_BIN = "/usr/local/bin/stop-window";

const COMMAND_TIMEOUT_MS = 20_000;
const PROBE_TIMEOUT_MS = 2_000;
const PORT_TIMEOUT_MS = 200;

export type TeamDesktopCommand = (
  file: string,
  args: readonly string[],
  timeoutMs: number,
) => Promise<number>;

/**
 * Talks to Grok Computer's window scripts as the current uid.
 * Display indexes outside 101–150 are rejected before any command or filesystem call.
 * The exec-daemon bearer, listen scope, and token-file mode are host behavior and stay as they are.
 */
export function createLinuxTeamDesktopHost(
  deps: { command?: TeamDesktopCommand } = {},
): TeamDesktopHost {
  const command = deps.command ?? defaultCommand;

  return {
    async xSocketExists(displayIndex) {
      assertTeamDesktopIndex(displayIndex);
      return exists(`/tmp/.X11-unix/X${displayIndex}`);
    },
    async tokenFileExists(displayIndex) {
      assertTeamDesktopIndex(displayIndex);
      return exists(`/tmp/sand-window-tokens.d/${displayIndex}`);
    },
    portListening(port) {
      return tcpOpen(port);
    },
    async windowAlive(displayIndex) {
      assertTeamDesktopIndex(displayIndex);
      const execPort = teamDesktopPorts(displayIndex).exec;
      if (!(await tcpOpen(execPort))) return false;
      const code = await command("xdpyinfo", ["-display", `:${displayIndex}`], PROBE_TIMEOUT_MS);
      return code === 0;
    },
    async startWindow(displayIndex, ownerToken) {
      assertTeamDesktopIndex(displayIndex);
      if (!ownerToken) throw new Error("Team desktop owner token is missing.");
      const code = await command(
        START_WINDOW_BIN,
        [String(displayIndex), ownerToken],
        COMMAND_TIMEOUT_MS,
      );
      if (code !== 0) throw new Error(`start-window exited ${code}`);
    },
    async stopWindow(displayIndex) {
      assertTeamDesktopIndex(displayIndex);
      const code = await command(STOP_WINDOW_BIN, [String(displayIndex)], COMMAND_TIMEOUT_MS);
      if (code !== 0) throw new Error(`stop-window exited ${code}`);
    },
    async purge(displayIndex) {
      assertTeamDesktopIndex(displayIndex);
      let names: string[] = [];
      try {
        names = await readdir("/tmp");
      } catch {
        names = [];
      }
      const open = await heldPaths();
      for (const target of teamDesktopPurgePaths(displayIndex, names)) {
        if (!purgeAllowed(target, displayIndex)) continue;
        if (!(await exists(target))) continue;
        if (open === null || pathHeld(target, open)) {
          getLogger().info("team desktop purge skipped a busy path", { displayIndex });
          continue;
        }
        await rm(target, { recursive: true, force: true });
      }
    },
  };
}

function defaultCommand(file: string, args: readonly string[], timeoutMs: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: "ignore" });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${path.basename(file)} timed out`));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code ?? 1);
    });
  });
}

function exists(target: string): Promise<boolean> {
  return access(target).then(
    () => true,
    () => false,
  );
}

function tcpOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const finish = (open: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(PORT_TIMEOUT_MS);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

/** Null when /proc cannot be read. Callers must not delete in that case. */
async function heldPaths(): Promise<Set<string> | null> {
  let pids: string[];
  try {
    pids = await readdir("/proc");
  } catch {
    return null;
  }
  const open = new Set<string>();
  for (const pid of pids) {
    if (!/^\d+$/.test(pid)) continue;
    let fds: string[];
    try {
      fds = await readdir(`/proc/${pid}/fd`);
    } catch {
      continue;
    }
    for (const fd of fds) {
      try {
        open.add(await readlink(`/proc/${pid}/fd/${fd}`));
      } catch {}
    }
  }
  return open;
}

function pathHeld(target: string, open: Set<string>): boolean {
  const prefix = target.endsWith("/") ? target : `${target}/`;
  for (const held of open) {
    if (held === target || held.startsWith(prefix)) return true;
  }
  return false;
}

function purgeAllowed(target: string, displayIndex: number): boolean {
  if (target.includes("..")) return false;
  if (target === `/tmp/.X11-unix/X${displayIndex}`) return true;
  if (target === `/tmp/.X${displayIndex}-lock`) return true;
  const base = path.basename(target);
  if (
    target === `/tmp/${base}` &&
    !base.includes("/") &&
    isTeamDesktopTmpLeftover(base, displayIndex)
  ) {
    return true;
  }
  for (const root of TEAM_DESKTOP_FORK_ROOTS) {
    if (target === `${root}/Fork-${displayIndex}`) return true;
  }
  return false;
}
