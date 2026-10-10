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

/**
 * Stock `control.py` waits this long for a long-lived launch. A process that
 * is still running is success; one that has already exited is its exit code.
 * The browser bound outlasts a profile scan plus a URL forward.
 */
const LAUNCH_SPAWN_POLL_SEC = "0.2";
const BROWSER_SPAWN_POLL_SEC = "2.4";

/**
 * Runs on the team desktop. Resolves an executable or an XDG `.desktop` entry,
 * then starts it with `setsid` and stdin/stdout/stderr on `/dev/null`.
 * The exec daemon keeps its stdout pipe open until every writer exits, so a
 * GUI that inherits that pipe holds the call until the command timeout.
 * `$1` is the poll in seconds, `$2` is the command name, and the rest are args.
 */
export const TEAM_DESKTOP_SPAWN_SCRIPT = `
poll=$1
name=$2
shift 2
case "$name" in
  */*)
    if [ -x "$name" ]; then
      set -- "$name" "$@"
    else
      echo "application not found: $name" >&2
      exit 127
    fi
    ;;
  *)
    cmd=""
    path=$PATH
    if [ -z "$path" ]; then
      path=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
    fi
    set -f
    old_ifs=$IFS
    IFS=:
    for dir in $path; do
      if [ -n "$dir" ] && [ -x "$dir/$name" ] && [ ! -d "$dir/$name" ]; then
        cmd=$dir/$name
        break
      fi
    done
    IFS=$old_ifs
    set +f
    if [ -n "$cmd" ]; then
      set -- "$cmd" "$@"
    else
      desktop=""
      if [ -n "$XDG_DATA_HOME" ]; then
        home_data=$XDG_DATA_HOME
      elif [ -n "$HOME" ]; then
        home_data=$HOME/.local/share
      else
        home_data=""
      fi
      if [ -n "$XDG_DATA_DIRS" ]; then
        data_dirs=$XDG_DATA_DIRS
      else
        data_dirs=/usr/local/share:/usr/share
      fi
      if [ -n "$home_data" ]; then
        data=$home_data:$data_dirs
      else
        data=$data_dirs
      fi
      set -f
      IFS=:
      for dir in $data; do
        if [ -n "$dir" ] && [ -f "$dir/applications/$name.desktop" ]; then
          desktop=$dir/applications/$name.desktop
          break
        fi
      done
      IFS=$old_ifs
      set +f
      if [ -z "$desktop" ]; then
        echo "application not found: $name" >&2
        exit 127
      fi
      if command -v gtk-launch >/dev/null 2>&1; then
        set -- gtk-launch "$name" "$@"
      elif command -v gio >/dev/null 2>&1; then
        set -- gio launch "$desktop" "$@"
      else
        echo "could not launch application: $name" >&2
        exit 127
      fi
    fi
    ;;
esac
setsid "$@" </dev/null >/dev/null 2>&1 &
pid=$!
sleep "$poll"
state=$(sed -e 's/.*) //' "/proc/$pid/stat" 2>/dev/null | cut -c1)
case "$state" in
  ""|Z)
    wait "$pid"
    status=$?
    if [ "$status" -ne 0 ]; then
      echo "could not launch application: $name" >&2
    fi
    exit "$status"
    ;;
esac
exit 0
`;

export function teamDesktopSpawnArgv(argv: string[]): string[] {
  const command = argv[0] ?? "";
  const base = command.slice(command.lastIndexOf("/") + 1);
  const poll =
    base === "box-chrome" || base === "rakazo-browser"
      ? BROWSER_SPAWN_POLL_SEC
      : LAUNCH_SPAWN_POLL_SEC;
  return ["sh", "-c", TEAM_DESKTOP_SPAWN_SCRIPT, "launch", poll, ...argv];
}

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
    await detached(
      exec,
      ["xdg-open", openTarget(action.path, resolveWorkspacePath)],
      "could not open path",
    );
    return;
  }
  const launch = launchSpec(action.application);
  const uri = action.uri ? [openUri(action.uri, resolveWorkspacePath)] : [];
  if (action.kind === "launch") {
    await detached(exec, [...launch.argv, ...uri], "could not launch application");
    return;
  }
  const found = await exec(["xdotool", "search", "--class", xdotoolClass(launch.wmClass)]);
  const ids = windowIds(found.stdout);
  if (ids.length === 0) {
    await detached(exec, [...launch.argv, ...uri], "could not launch application");
    return;
  }
  if (uri.length > 0)
    await detached(exec, [...launch.argv, ...uri], "could not launch application");
  const windowId = ids[0];
  if (!windowId) {
    await detached(exec, [...launch.argv, ...uri], "could not launch application");
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

async function detached(exec: HandExec, argv: string[], fallback: string): Promise<void> {
  const started = await exec(teamDesktopSpawnArgv(argv));
  if (started.code !== 0) {
    throw new Error(started.stderr.trim() || fallback);
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
