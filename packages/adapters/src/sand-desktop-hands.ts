import type { ComputerAction } from "@rakazo/adapter-kit";
import { BROWSER_APPLICATIONS } from "@rakazo/core/node/desktop-runtime";
import { SAND_TEAM_BROWSER } from "./sand-host.js";

export type TeamDesktopHand = Extract<ComputerAction, { kind: "open" | "focus" | "launch" }>;

export interface HandExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type HandExec = (argv: string[]) => Promise<HandExecResult>;

const LAUNCH_NAME = /^[A-Za-z0-9_@.+-]{1,64}$/;

export function isTeamDesktopHand(action: ComputerAction): action is TeamDesktopHand {
  return action.kind === "open" || action.kind === "focus" || action.kind === "launch";
}

/** Raise an existing window, or start the application when none matches. */
export async function runTeamDesktopHand(
  action: TeamDesktopHand,
  exec: HandExec,
  resolveWorkspacePath: (input: string | undefined) => string,
): Promise<void> {
  if (action.kind === "open") {
    const opened = await exec(["xdg-open", openTarget(action.path, resolveWorkspacePath)]);
    if (opened.code !== 0) {
      throw new Error(opened.stderr.trim() || "could not open path");
    }
    return;
  }
  const launch = launchSpec(action.application);
  const uri = action.uri ? [openUri(action.uri, resolveWorkspacePath)] : [];
  if (action.kind === "launch") {
    await detached(exec, launch.argv, uri);
    return;
  }
  const found = await exec(["xdotool", "search", "--class", xdotoolClass(launch.wmClass)]);
  const ids = windowIds(found.stdout);
  if (ids.length === 0) {
    await detached(exec, launch.argv, uri);
    return;
  }
  if (uri.length > 0) await detached(exec, launch.argv, uri);
  const windowId = ids[0];
  if (!windowId) {
    await detached(exec, launch.argv, uri);
    return;
  }
  const activated = await exec(["xdotool", "windowactivate", windowId]);
  if (activated.code !== 0) {
    throw new Error(activated.stderr.trim() || "could not focus window");
  }
}

function openTarget(
  path: string,
  resolveWorkspacePath: (input: string | undefined) => string,
): string {
  if (/^https?:\/\//i.test(path)) return httpUrl(path);
  return resolveWorkspacePath(path);
}

function openUri(uri: string, resolveWorkspacePath: (input: string | undefined) => string): string {
  if (/^https?:\/\//i.test(uri)) return httpUrl(uri);
  if (/[\0\r\n]/.test(uri) || uri.length > 8192) throw new Error("sand launch refused");
  if (uri.startsWith("/")) return resolveWorkspacePath(uri);
  return uri;
}

function httpUrl(value: string): string {
  if (value.length > 8192 || /[\0\r\n]/.test(value)) throw new Error("sand open refused");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("sand open refused");
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    throw new Error("sand open refused");
  }
  return value;
}

function launchSpec(application: string): { argv: string[]; wmClass: string } {
  const name = application.trim();
  if (!name || name.includes("/") || name.startsWith("-")) throw new Error("sand launch refused");
  if (BROWSER_APPLICATIONS.has(name.toLowerCase())) {
    return { argv: [SAND_TEAM_BROWSER], wmClass: "google-chrome" };
  }
  if (!LAUNCH_NAME.test(name)) throw new Error("sand launch refused");
  return { argv: [name], wmClass: name };
}

async function detached(exec: HandExec, argv: string[], extra: string[]): Promise<void> {
  const started = await exec(["setsid", "-f", ...argv, ...extra]);
  if (started.code !== 0) {
    throw new Error(started.stderr.trim() || "could not launch application");
  }
}

/** `xdotool search --class` is a regex. Match the class text literally. */
export function xdotoolClass(value: string): string {
  return value.replace(/[\\^$.|?*+()[\]{}]/g, "\\$&");
}

function windowIds(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^\d+$/.test(line));
}
