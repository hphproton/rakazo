import { readdir, readFile } from "node:fs/promises";
import {
  assertTeamDesktopIndex,
  TEAM_DESKTOP_MAX_INDEX,
  TEAM_DESKTOP_MIN_INDEX,
} from "./team-desktop.js";

/**
 * stop-window kills Xvfb, x11vnc, and the exec-daemon. start-window has already
 * detached start-desktop.sh (it ends in `tail -f /dev/null`) and a dbus-daemon,
 * so those survive and are reparented. This finds that leftover tree for a
 * team desktop and signals it. A session that still contains Xvfb :N is a live
 * desktop and is not touched. Indexes outside 101–150 are refused.
 */
export const TEAM_DESKTOP_ORPHAN_GRACE_MS = 200;

const READ_CHUNK = 32;

export interface TeamDesktopProc {
  pid: number;
  uid: number;
  sid: number;
  pgid: number;
  startTicks: number;
  argv: readonly string[];
  /** Set for dbus-daemon only, from DISPLAY in the environment. */
  display?: string;
}

export interface TeamDesktopOrphanPlan {
  groups: Array<{ pgid: number; pids: number[] }>;
  dbusPids: number[];
}

export interface TeamDesktopOrphanCleanup {
  displayIndex: number;
  sessions: number;
  dbus: number;
}

export interface TeamDesktopOrphanControl {
  list(): Promise<readonly TeamDesktopProc[]>;
  signal(pid: number, signal: NodeJS.Signals): void;
  alive(pid: number): boolean;
  sleep(ms: number): Promise<void>;
  uid(): number;
}

export function teamDesktopOrphanBand(): number[] {
  const indexes: number[] = [];
  for (
    let displayIndex = TEAM_DESKTOP_MIN_INDEX;
    displayIndex <= TEAM_DESKTOP_MAX_INDEX;
    displayIndex += 1
  ) {
    indexes.push(displayIndex);
  }
  return indexes;
}

export function planTeamDesktopOrphanCleanup(
  displayIndex: number,
  procs: readonly TeamDesktopProc[],
  uid: number,
  selfPids: ReadonlySet<number>,
): TeamDesktopOrphanPlan {
  assertTeamDesktopIndex(displayIndex);
  const selfPgids = new Set<number>();
  for (const proc of procs) {
    if (selfPids.has(proc.pid) && proc.pgid > 1) selfPgids.add(proc.pgid);
  }

  const bySid = new Map<number, TeamDesktopProc[]>();
  for (const proc of procs) {
    if (proc.uid !== uid || proc.pid <= 1 || proc.sid <= 1) continue;
    const members = bySid.get(proc.sid);
    if (members) members.push(proc);
    else bySid.set(proc.sid, [proc]);
  }

  const liveSids = new Set<number>();
  let liveBoundStart: number | undefined;
  let externalXvfbStart: number | undefined;
  const groups: Array<{ pgid: number; pids: number[] }> = [];
  let orphanStart: number | undefined;

  for (const [sid, members] of bySid) {
    const bound = sessionBound(members, displayIndex);
    const holdsXvfb = members.some(
      (proc) => isXvfbArgv(proc.argv) && hasDisplayArg(proc.argv, displayIndex),
    );
    const touchesSelf =
      selfPgids.has(groupId(members, sid)) || members.some((proc) => selfPids.has(proc.pid));
    if (bound && holdsXvfb) {
      liveSids.add(sid);
      liveBoundStart = earlier(liveBoundStart, earliest(members));
    }
    if (touchesSelf || !bound || holdsXvfb) continue;
    const pgid = groupId(members, sid);
    if (pgid <= 1 || selfPgids.has(pgid)) continue;
    groups.push({ pgid, pids: members.map((proc) => proc.pid) });
    orphanStart = earlier(orphanStart, earliest(members));
  }

  for (const proc of procs) {
    if (proc.uid !== uid || selfPids.has(proc.pid) || liveSids.has(proc.sid)) continue;
    if (!isXvfbArgv(proc.argv) || !hasDisplayArg(proc.argv, displayIndex)) continue;
    externalXvfbStart = earlier(externalXvfbStart, proc.startTicks);
  }

  const liveStart = liveBoundStart ?? externalXvfbStart;
  const dbusPids: number[] = [];
  for (const proc of procs) {
    if (proc.uid !== uid || proc.pid <= 1 || selfPids.has(proc.pid)) continue;
    if (liveSids.has(proc.sid) || !isDbusArgv(proc.argv)) continue;
    if (!displayMatches(proc.display, displayIndex)) continue;
    if (!dbusLeftover(proc.startTicks, orphanStart, liveStart)) continue;
    dbusPids.push(proc.pid);
  }

  return { groups, dbusPids };
}

export async function cleanTeamDesktopOrphans(
  displayIndexes: readonly number[],
  control: TeamDesktopOrphanControl,
): Promise<TeamDesktopOrphanCleanup[]> {
  for (const displayIndex of displayIndexes) assertTeamDesktopIndex(displayIndex);
  if (displayIndexes.length === 0) return [];
  const procs = await control.list();
  const uid = control.uid();
  const selfPids = new Set<number>([process.pid]);
  if (process.ppid > 0) selfPids.add(process.ppid);

  const planned: Array<{ displayIndex: number; plan: TeamDesktopOrphanPlan }> = [];
  for (const displayIndex of displayIndexes) {
    const plan = planTeamDesktopOrphanCleanup(displayIndex, procs, uid, selfPids);
    if (plan.groups.length === 0 && plan.dbusPids.length === 0) continue;
    planned.push({ displayIndex, plan });
  }
  if (planned.length === 0) return [];
  await signalPlans(
    planned.map((entry) => entry.plan),
    control,
    selfPids,
  );
  return planned.map((entry) => ({
    displayIndex: entry.displayIndex,
    sessions: entry.plan.groups.length,
    dbus: entry.plan.dbusPids.length,
  }));
}

export function linuxTeamDesktopOrphanControl(): TeamDesktopOrphanControl {
  return {
    list: readTeamDesktopProcTable,
    signal: signalPid,
    alive: pidAlive,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    uid: () => process.getuid?.() ?? -1,
  };
}

export async function readTeamDesktopProcTable(): Promise<TeamDesktopProc[]> {
  const uid = process.getuid?.();
  if (uid === undefined) return [];
  let names: string[];
  try {
    names = await readdir("/proc");
  } catch {
    return [];
  }
  const pids = names.filter((name) => /^\d+$/.test(name));
  const procs: TeamDesktopProc[] = [];
  for (let offset = 0; offset < pids.length; offset += READ_CHUNK) {
    const chunk = pids.slice(offset, offset + READ_CHUNK);
    const read = await Promise.all(chunk.map((name) => readProc(Number(name), uid)));
    for (const proc of read) {
      if (proc) procs.push(proc);
    }
  }
  return procs;
}

function sessionBound(members: readonly TeamDesktopProc[], displayIndex: number): boolean {
  let script = false;
  let log = false;
  const marker = `/tmp/sand-window-${displayIndex}/`;
  for (const proc of members) {
    if (!script && isStartDesktopArgv(proc.argv)) script = true;
    if (!log && proc.argv.some((arg) => arg.includes(marker))) log = true;
    if (script && log) return true;
  }
  return false;
}

function groupId(members: readonly TeamDesktopProc[], sid: number): number {
  const leader = members.find((proc) => proc.pid === sid);
  if (leader && leader.pgid > 1) return leader.pgid;
  return sid;
}

function earliest(members: readonly TeamDesktopProc[]): number {
  let start = members[0]?.startTicks ?? 0;
  for (const proc of members) {
    if (proc.startTicks < start) start = proc.startTicks;
  }
  return start;
}

function earlier(current: number | undefined, next: number): number {
  return current === undefined || next < current ? next : current;
}

/**
 * dbus-launch is a child of start-desktop.sh, so its daemon starts at or after
 * that session. A later live session's daemon starts at or after the live
 * session and must stay.
 */
function dbusLeftover(
  startTicks: number,
  orphanStart: number | undefined,
  liveStart: number | undefined,
): boolean {
  if (liveStart === undefined) return orphanStart === undefined || startTicks >= orphanStart;
  if (orphanStart === undefined) return false;
  return startTicks >= orphanStart && startTicks < liveStart;
}

function isStartDesktopArgv(argv: readonly string[]): boolean {
  return argv.some((arg) => commandName(arg) === "start-desktop.sh");
}

function isXvfbArgv(argv: readonly string[]): boolean {
  return argv.some((arg) => commandName(arg) === "Xvfb");
}

function isDbusArgv(argv: readonly string[]): boolean {
  return argv.length > 0 && commandName(argv[0] ?? "") === "dbus-daemon";
}

function hasDisplayArg(argv: readonly string[], displayIndex: number): boolean {
  return argv.some((arg) => displayMatches(arg, displayIndex));
}

function displayMatches(value: string | undefined, displayIndex: number): boolean {
  if (!value) return false;
  return value === `:${displayIndex}` || value.startsWith(`:${displayIndex}.`);
}

function commandName(arg: string): string {
  const slash = Math.max(arg.lastIndexOf("/"), arg.lastIndexOf("\\"));
  return slash >= 0 ? arg.slice(slash + 1) : arg;
}

async function signalPlans(
  plans: readonly TeamDesktopOrphanPlan[],
  control: TeamDesktopOrphanControl,
  selfPids: ReadonlySet<number>,
): Promise<void> {
  const tracked = new Set<number>();
  const groups: number[] = [];
  const term = (pid: number) => {
    if (!canSignal(pid, selfPids)) return;
    control.signal(pid, "SIGTERM");
    if (pid > 0) tracked.add(pid);
  };
  for (const plan of plans) {
    for (const group of plan.groups) {
      groups.push(group.pgid);
      term(-group.pgid);
      for (const pid of group.pids) term(pid);
    }
    for (const pid of plan.dbusPids) term(pid);
  }
  if (tracked.size === 0) return;
  await control.sleep(TEAM_DESKTOP_ORPHAN_GRACE_MS);
  const survivors = [...tracked].filter((pid) => control.alive(pid));
  if (survivors.length === 0) return;
  for (const pgid of groups) {
    if (canSignal(-pgid, selfPids)) control.signal(-pgid, "SIGKILL");
  }
  for (const pid of survivors) {
    if (canSignal(pid, selfPids)) control.signal(pid, "SIGKILL");
  }
}

function canSignal(pid: number, selfPids: ReadonlySet<number>): boolean {
  if (!Number.isInteger(pid) || pid === 0 || pid === -1 || pid === 1) return false;
  const target = pid < 0 ? -pid : pid;
  return target > 1 && !selfPids.has(target);
}

function signalPid(pid: number, signal: NodeJS.Signals): void {
  if (!Number.isInteger(pid) || pid === 0 || pid === -1 || pid === 1) return;
  if (pid < 0 && -pid <= 1) return;
  try {
    process.kill(pid, signal);
  } catch {
    // Already gone, or not our process.
  }
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readProc(pid: number, uid: number): Promise<TeamDesktopProc | undefined> {
  const dir = `/proc/${pid}`;
  let statRaw: string;
  let statusRaw: string;
  let cmdRaw: string;
  try {
    [statRaw, statusRaw, cmdRaw] = await Promise.all([
      readFile(`${dir}/stat`, "utf8"),
      readFile(`${dir}/status`, "utf8"),
      readFile(`${dir}/cmdline`, "utf8"),
    ]);
  } catch {
    return undefined;
  }
  const parsed = parseProcStat(statRaw);
  if (!parsed || parsed.state === "Z" || parsed.pid !== pid) return undefined;
  const procUid = parseUid(statusRaw);
  if (procUid !== uid) return undefined;
  const argv = splitCmdline(cmdRaw);
  const proc: TeamDesktopProc = {
    pid,
    uid: procUid,
    sid: parsed.sid,
    pgid: parsed.pgid,
    startTicks: parsed.startTicks,
    argv,
  };
  if (!isDbusArgv(argv)) return proc;
  try {
    const display = displayFromEnviron(await readFile(`${dir}/environ`, "utf8"));
    if (display !== undefined) proc.display = display;
  } catch {
    // Environment disappeared with the process.
  }
  return proc;
}

function parseProcStat(
  stat: string,
): { pid: number; state: string; pgid: number; sid: number; startTicks: number } | undefined {
  const open = stat.indexOf("(");
  const close = stat.lastIndexOf(")");
  if (open < 1 || close < open) return undefined;
  const pid = Number(stat.slice(0, open).trim());
  const rest = stat
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  const state = rest[0];
  const pgid = Number(rest[2]);
  const sid = Number(rest[3]);
  const startTicks = Number(rest[19]);
  if (!state || ![pid, pgid, sid, startTicks].every((value) => Number.isFinite(value))) {
    return undefined;
  }
  return { pid, state, pgid, sid, startTicks };
}

function parseUid(status: string): number | undefined {
  for (const line of status.split("\n")) {
    if (!line.startsWith("Uid:")) continue;
    const uid = Number(line.split(/\s+/)[1]);
    return Number.isInteger(uid) ? uid : undefined;
  }
  return undefined;
}

function splitCmdline(raw: string): string[] {
  if (!raw) return [];
  const parts = raw.split("\0");
  if (parts.at(-1) === "") parts.pop();
  return parts;
}

function displayFromEnviron(raw: string): string | undefined {
  for (const entry of raw.split("\0")) {
    if (!entry.startsWith("DISPLAY=")) continue;
    return entry.slice("DISPLAY=".length);
  }
  return undefined;
}
