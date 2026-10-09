import { watch } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";
import { getLogger } from "@rakazo/logging";
import { TEAM_DESKTOP_MAX_INDEX, TEAM_DESKTOP_MIN_INDEX } from "./team-desktop.js";

/**
 * Standard X11 socket directory. Display N is the entry `XN`.
 * This is the signal that a team desktop's X server is gone. Seat sockets
 * (anything outside 101–150) are ignored.
 *
 * The watch does not replace the host details that are a different signal:
 * `start-window` / `stop-window`, orphan matching on `start-desktop.sh` and
 * `/tmp/sand-window-N/`, token files under `/tmp/sand-window-tokens.d`, and
 * the exec/CDP/VNC/pty ports. Those stay; see
 * `docs/self-host-sandbox-providers.md`.
 */
export const TEAM_DESKTOP_X11_DIR = "/tmp/.X11-unix";

/** Collapse the burst of inotify events for one socket into one callback. */
export const TEAM_DESKTOP_X11_DEBOUNCE_MS = 200;

export type TeamDesktopDirectoryListener = (
  event: string,
  filename: string | Buffer | null,
) => void;

export type TeamDesktopDirectoryWatch = (
  directory: string,
  listener: TeamDesktopDirectoryListener,
) => { close(): void };

/**
 * `X101`–`X150` only. `X20`, `X100`, `X151`, and `X1010` are not team desktops.
 * A zero-padded name is not a socket name.
 */
export function teamDesktopIndexFromXSocket(name: string | null | undefined): number | undefined {
  if (!name) return undefined;
  if (!name.startsWith("X")) return undefined;
  const digits = name.slice(1);
  if (!/^[1-9]\d*$/.test(digits)) return undefined;
  const displayIndex = Number(digits);
  if (displayIndex < TEAM_DESKTOP_MIN_INDEX || displayIndex > TEAM_DESKTOP_MAX_INDEX) {
    return undefined;
  }
  return displayIndex;
}

export function watchTeamDesktopXSockets(options: {
  directory?: string;
  debounceMs?: number;
  watchDirectory?: TeamDesktopDirectoryWatch;
  /** True when `XN` is still in the socket directory. */
  socketExists?: (displayIndex: number) => Promise<boolean>;
  onGone: (displayIndex: number) => void | Promise<void>;
}): { close(): void } {
  const directory = options.directory ?? TEAM_DESKTOP_X11_DIR;
  const debounceMs = options.debounceMs ?? TEAM_DESKTOP_X11_DEBOUNCE_MS;
  const socketExists =
    options.socketExists ?? ((displayIndex) => xSocketFileExists(directory, displayIndex));
  const openWatch = options.watchDirectory ?? watchX11Directory;
  const pending = new Map<number, ReturnType<typeof setTimeout>>();
  let closed = false;

  const watcher = openWatch(directory, (_event, filename) => {
    if (closed) return;
    const displayIndex = teamDesktopIndexFromXSocket(socketEventName(filename));
    if (displayIndex === undefined) return;
    const existing = pending.get(displayIndex);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      pending.delete(displayIndex);
      if (closed) return;
      void confirmGone(displayIndex);
    }, debounceMs);
    pending.set(displayIndex, timer);
  });

  async function confirmGone(displayIndex: number): Promise<void> {
    if (closed) return;
    if (await socketExists(displayIndex)) return;
    if (closed) return;
    try {
      await options.onGone(displayIndex);
    } catch (error) {
      getLogger().error("team desktop display watch cleanup failed", error);
    }
  }

  return {
    close() {
      if (closed) return;
      closed = true;
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
      watcher.close();
    },
  };
}

function socketEventName(filename: string | Buffer | null): string | undefined {
  if (filename == null) return undefined;
  const name = typeof filename === "string" ? filename : filename.toString("utf8");
  return name || undefined;
}

async function xSocketFileExists(directory: string, displayIndex: number): Promise<boolean> {
  try {
    await access(path.join(directory, `X${displayIndex}`));
    return true;
  } catch {
    return false;
  }
}

function watchX11Directory(
  directory: string,
  listener: TeamDesktopDirectoryListener,
): { close(): void } {
  const watcher = watch(directory, { persistent: true }, (event, filename) => {
    listener(event, filename);
  });
  watcher.on("error", (error) => {
    getLogger().error("team desktop display watch failed", error);
  });
  return {
    close() {
      watcher.close();
    },
  };
}
