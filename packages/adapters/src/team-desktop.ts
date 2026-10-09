import { randomBytes } from "node:crypto";
import { ACTIVE_RUN_STATUSES, HUB_SPAWN_KEY_PREFIX, VISIBLE_ROSTER_BOT_WHERE } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";

/** Host seats stay in 2..100. Team desktops use only this band. */
export const TEAM_DESKTOP_MIN_INDEX = 101;
export const TEAM_DESKTOP_MAX_INDEX = 150;

export const TEAM_DESKTOP_ROUTER_URL = "http://127.0.0.1:1339";

export const TEAM_DESKTOP_DEFAULT_IDLE_MINUTES = 30;
export const TEAM_DESKTOP_DEFAULT_RECONCILE_SECONDS = 120;
export const TEAM_DESKTOP_DEFAULT_MAX_RUNNING = 4;
export const TEAM_DESKTOP_ENSURE_TIMEOUT_MS = 15_000;

const POLL_MS = 200;

/** Only `Fork-N` under these roots is purged, and only for N in 101–150. Never `Default`. */
export const TEAM_DESKTOP_FORK_ROOTS = [
  "/tmp",
  "/home/box/.config/google-chrome",
  "/home/box/.config/chromium",
  "/home/box/chrome-profile",
] as const;

export type TeamDesktopState = "reserved" | "booting" | "running" | "stopped" | "releasing";

/**
 * Card state, using the computer status words. A window that is not booting
 * or running is stock asleep (`suspended`), not a new label.
 */
export type TeamDesktopCardState = "suspended" | "booting" | "running";

/**
 * What the computer card should show for this desktop.
 * Reserved, releasing, and stopped have no window, so the card is asleep.
 */
export function teamDesktopCardState(state: TeamDesktopState): TeamDesktopCardState {
  if (state === "running" || state === "booting") return state;
  return "suspended";
}

export interface TeamDesktopRecord {
  botId: string;
  displayIndex: number;
  ownerToken: string;
  state: TeamDesktopState;
  lastUsedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Client-visible row. The owner token is never included. */
export interface TeamDesktopStatus {
  botId: string;
  displayIndex: number;
  state: TeamDesktopState;
  lastUsedAt: string | null;
}

/** In-process route for the sand adapter. Do not log `ownerToken`. */
export interface TeamDesktopBinding {
  displayIndex: number;
  ownerToken: string;
}

export interface TeamDesktopStore {
  getByBot(botId: string): Promise<TeamDesktopRecord | null>;
  list(): Promise<TeamDesktopRecord[]>;
  insert(row: TeamDesktopRecord): Promise<void>;
  update(
    botId: string,
    patch: Partial<Pick<TeamDesktopRecord, "state" | "lastUsedAt">>,
  ): Promise<void>;
  delete(botId: string): Promise<void>;
}

/**
 * Probes and commands for one display index in 101–150.
 * Implementations must refuse every other index before touching the host.
 */
export interface TeamDesktopHost {
  xSocketExists(displayIndex: number): Promise<boolean>;
  tokenFileExists(displayIndex: number): Promise<boolean>;
  portListening(port: number): Promise<boolean>;
  /**
   * The X socket exists, TCP 127.0.0.1:(14000+N) accepts, and
   * `xdpyinfo -display :N` exits 0. A listening exec port with no socket is
   * not a live display.
   */
  windowAlive(displayIndex: number): Promise<boolean>;
  startWindow(displayIndex: number, ownerToken: string): Promise<void>;
  stopWindow(displayIndex: number): Promise<void>;
  /**
   * Kill leftover start-desktop sessions and dbus-daemon processes for N.
   * A session that still contains Xvfb :N is left alone.
   */
  cleanWindow(displayIndex: number): Promise<void>;
  /** One pass over 101–150. Does not call stop-window and does not touch seats. */
  cleanOrphans(): Promise<void>;
  /** Delete only this index's leftovers, and only when no process holds them. */
  purge(displayIndex: number): Promise<void>;
}

export interface TeamDesktopAllocator {
  reserve(botId: string): Promise<TeamDesktopStatus>;
  ensure(botId: string): Promise<TeamDesktopBinding>;
  stop(botId: string): Promise<TeamDesktopStatus>;
  release(botId: string): Promise<void>;
  status(botId: string): Promise<TeamDesktopStatus | null>;
  resolve(botId: string): Promise<TeamDesktopBinding | undefined>;
  /** True when this bot is a current team member. Hub mirrors are not. */
  member(botId: string): Promise<boolean>;
  /**
   * `XN` for this display disappeared. A running or booting row becomes
   * stopped, which is the card's asleep state, and the orphan cleanup runs
   * once. An already-stopped row was cleaned by the stop that removed the
   * socket. Indexes outside 101–150 are ignored.
   */
  noteDisplayGone(displayIndex: number): Promise<void>;
  /**
   * One pass for process start. A booting or running row with no live X
   * socket, or a socket whose X server is not up, is stopped and cleaned.
   * Does not idle-stop a live desktop; the periodic reconcile still does that.
   */
  sweepMissingDisplays(): Promise<void>;
  /** Periodic pass. Also the fallback when the socket watch misses an event. */
  reconcile(): Promise<void>;
  reconcileIfDue(): Promise<void>;
  syncMembership(memberBotIds: readonly string[]): Promise<void>;
}

export class TeamDesktopError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TeamDesktopError";
  }
}

export class TeamDesktopExhaustedError extends TeamDesktopError {
  constructor() {
    super("No free Team desktop in 101-150.");
    this.name = "TeamDesktopExhaustedError";
  }
}

export class TeamDesktopLimitError extends TeamDesktopError {
  constructor(maxRunning: number) {
    super(
      `Team desktop limit reached (${maxRunning} running). No idle desktop is available to stop.`,
    );
    this.name = "TeamDesktopLimitError";
  }
}

export class TeamDesktopMissingError extends TeamDesktopError {
  constructor(botId: string) {
    super(`No Team desktop is reserved for ${botId}.`);
    this.name = "TeamDesktopMissingError";
  }
}

export class TeamDesktopConflictError extends Error {
  constructor() {
    super("team desktop unique conflict");
    this.name = "TeamDesktopConflictError";
  }
}

export function assertTeamDesktopIndex(displayIndex: number): void {
  if (
    !Number.isInteger(displayIndex) ||
    displayIndex < TEAM_DESKTOP_MIN_INDEX ||
    displayIndex > TEAM_DESKTOP_MAX_INDEX
  ) {
    throw new TeamDesktopError(`Team desktop index ${displayIndex} is outside 101-150.`);
  }
}

export function teamDesktopPorts(displayIndex: number): {
  cdp: number;
  exec: number;
  vnc: number;
  pty: number;
} {
  assertTeamDesktopIndex(displayIndex);
  // Sand desktops bind the browser debugger at 9222+N (display 111 → 9333).
  // The Docker computer runtime uses 9221+display and is a different process.
  return {
    cdp: 9222 + displayIndex,
    exec: 14000 + displayIndex,
    vnc: 5900 + displayIndex,
    pty: 13600 + displayIndex,
  };
}

export function teamDesktopCdpBusyMessage(displayIndex: number): string {
  const port = teamDesktopPorts(displayIndex).cdp;
  return `Team desktop ${displayIndex} CDP port ${port} is already in use.`;
}

/** Viewer for display N. The query value is the index, not the owner token. */
export function teamDesktopViewerUrl(displayIndex: number): string {
  assertTeamDesktopIndex(displayIndex);
  return `http://127.0.0.1:6081?token=${displayIndex}`;
}

/**
 * `/tmp` names that belong to display N: colon leftovers (`:101` but not `:1010`
 * or `:10`) plus the X lock and socket file names.
 */
export function isTeamDesktopTmpLeftover(name: string, displayIndex: number): boolean {
  if (!Number.isInteger(displayIndex) || displayIndex < 101 || displayIndex > 150) return false;
  if (name === `.X${displayIndex}-lock` || name === `X${displayIndex}`) return true;
  // `:101` matches; `:1010` and `:10` do not. The character before the colon may be a digit (`xfwm4:101`).
  const pattern = new RegExp(`:${displayIndex}(?:[^0-9]|$)`);
  return pattern.test(name);
}

/** Paths purge may delete for this index. Nothing outside 101–150, and not `/tmp` itself. */
export function teamDesktopPurgePaths(displayIndex: number, tmpNames: readonly string[]): string[] {
  assertTeamDesktopIndex(displayIndex);
  const paths = new Set<string>([`/tmp/.X11-unix/X${displayIndex}`, `/tmp/.X${displayIndex}-lock`]);
  for (const name of tmpNames) {
    if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\")) {
      continue;
    }
    if (isTeamDesktopTmpLeftover(name, displayIndex)) paths.add(`/tmp/${name}`);
  }
  for (const root of TEAM_DESKTOP_FORK_ROOTS) {
    paths.add(`${root}/Fork-${displayIndex}`);
  }
  return [...paths];
}

/** A bot counted for a team desktop. Scope is `Bot.computer.scope`. */
export interface TeamDesktopMember {
  id: string;
  archived: boolean;
  computerScope: string | null;
  /** Hub roster mirrors use a `hub:` spawn key and are not members. */
  spawnKey?: string | null;
}

/**
 * Non-archived bots whose computer scope is `team`, excluding Hub roster mirrors.
 * A private computer, a missing computer, an archived bot, or a `hub:` spawn key is not a member.
 */
export function teamDesktopMemberBotIds(bots: readonly TeamDesktopMember[]): string[] {
  const ids: string[] = [];
  for (const bot of bots) {
    if (bot.archived || bot.computerScope !== "team") continue;
    if (bot.spawnKey?.startsWith(HUB_SPAWN_KEY_PREFIX)) continue;
    ids.push(bot.id);
  }
  return [...new Set(ids)];
}

/** Prisma filter for `listTeamBMemberBotIds`. Hub mirrors stay out of the band. */
export function teamDesktopMemberBotWhere() {
  return {
    archivedAt: null,
    computer: { is: { scope: "team" } },
    ...VISIBLE_ROSTER_BOT_WHERE,
  } as const;
}

/**
 * The allocator talks to the host only when the sandbox provider is `sand`.
 * fake, docker, e2b, none, and every other provider skip open entirely.
 */
export function teamDesktopAllocatorForProvider<T>(provider: string, open: () => T): T | undefined {
  if (provider !== "sand") return undefined;
  return open();
}

/** Message the bot should see when this call cannot take a desktop. Other errors stay thrown. */
export function teamDesktopCapacityMessage(error: unknown): string | undefined {
  if (error instanceof TeamDesktopExhaustedError || error instanceof TeamDesktopLimitError) {
    return error.message;
  }
  return undefined;
}

export function teamDesktopConfigFromEnv(source: NodeJS.ProcessEnv = process.env): {
  idleMinutes: number;
  reconcileSeconds: number;
  maxRunning: number;
} {
  return {
    idleMinutes: positiveInteger(
      source.TEAM_DESKTOP_IDLE_MINUTES,
      TEAM_DESKTOP_DEFAULT_IDLE_MINUTES,
    ),
    reconcileSeconds: positiveInteger(
      source.TEAM_DESKTOP_RECONCILE_SECONDS,
      TEAM_DESKTOP_DEFAULT_RECONCILE_SECONDS,
    ),
    maxRunning: positiveInteger(source.TEAM_DESKTOP_MAX_RUNNING, TEAM_DESKTOP_DEFAULT_MAX_RUNNING),
  };
}

export function createTeamDesktopAllocator(options: {
  store: TeamDesktopStore;
  host: TeamDesktopHost;
  idleMinutes?: number;
  maxRunning?: number;
  reconcileSeconds?: number;
  ensureTimeoutMs?: number;
  pollMs?: number;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /** Current member bot ids. Reconcile re-syncs from this list. */
  members?: () => Promise<readonly string[]>;
  /**
   * Bots with a run still in progress. Those desktops are not idle-stopped
   * or cap-evicted. When a bot leaves this set, its idle clock starts then.
   */
  activeRuns?: () => Promise<readonly string[]>;
  /**
   * Fired when the card-visible state changes. Must not include the owner token.
   * Callers publish; this allocator does not wait on them.
   */
  onState?: (botId: string, state: TeamDesktopCardState) => void | Promise<void>;
}): TeamDesktopAllocator {
  const idleMinutes = options.idleMinutes ?? TEAM_DESKTOP_DEFAULT_IDLE_MINUTES;
  const maxRunning = options.maxRunning ?? TEAM_DESKTOP_DEFAULT_MAX_RUNNING;
  const reconcileSeconds = options.reconcileSeconds ?? TEAM_DESKTOP_DEFAULT_RECONCILE_SECONDS;
  const ensureTimeoutMs = options.ensureTimeoutMs ?? TEAM_DESKTOP_ENSURE_TIMEOUT_MS;
  const pollMs = options.pollMs ?? POLL_MS;
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const store = options.store;
  const host = options.host;
  const members = options.members;
  const activeRuns = options.activeRuns;
  const onState = options.onState;
  const watchedRuns = new Set<string>();
  let tail: Promise<unknown> = Promise.resolve();
  let lastReconcileAt = 0;

  function exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = tail.then(fn, fn);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  function idleCutoff(): number {
    return now().getTime() - idleMinutes * 60_000;
  }

  function isIdle(row: TeamDesktopRecord): boolean {
    return (row.lastUsedAt?.getTime() ?? 0) <= idleCutoff();
  }

  function holdsRunningSlot(state: TeamDesktopState): boolean {
    return state === "running" || state === "booting";
  }

  function notifyCard(botId: string, previous: TeamDesktopState, next: TeamDesktopState) {
    const before = teamDesktopCardState(previous);
    const after = teamDesktopCardState(next);
    if (before === after || !onState) return;
    void Promise.resolve(onState(botId, after)).catch((error: unknown) => {
      getLogger().error("team desktop status event failed", error);
    });
  }

  return {
    reserve(botId) {
      return exclusive(() => reserveBody(botId));
    },
    ensure(botId) {
      return exclusive(() => ensureBody(botId));
    },
    stop(botId) {
      return exclusive(async () => {
        const status = await stopBody(botId);
        if (!status) throw new TeamDesktopMissingError(botId);
        return status;
      });
    },
    release(botId) {
      return exclusive(() => releaseBody(botId));
    },
    status(botId) {
      return store.getByBot(botId).then((row) => (row ? toStatus(row) : null));
    },
    async resolve(botId) {
      const row = await store.getByBot(botId);
      // Only a live window is a screen. Stopped and booting must not hand out a viewer,
      // and this read must not start one.
      if (row?.state !== "running") return undefined;
      return { displayIndex: row.displayIndex, ownerToken: row.ownerToken };
    },
    async member(botId) {
      if (!members) return false;
      return (await members()).includes(botId);
    },
    noteDisplayGone(displayIndex) {
      return exclusive(() => noteDisplayGoneBody(displayIndex));
    },
    sweepMissingDisplays() {
      return exclusive(() => sweepMissingDisplaysBody());
    },
    reconcile() {
      return exclusive(() => reconcileBody());
    },
    reconcileIfDue() {
      return exclusive(async () => {
        const due = now().getTime() - lastReconcileAt >= reconcileSeconds * 1000;
        if (!due) return;
        await reconcileBody();
      });
    },
    syncMembership(memberBotIds) {
      return exclusive(() => syncBody(memberBotIds));
    },
  };

  async function reserveBody(botId: string): Promise<TeamDesktopStatus> {
    const existing = await store.getByBot(botId);
    if (existing) return toStatus(existing);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const displayIndex = await pickIndex();
      const ownerToken = randomBytes(32).toString("base64url");
      const createdAt = now();
      try {
        await store.insert({
          botId,
          displayIndex,
          ownerToken,
          state: "reserved",
          lastUsedAt: null,
          createdAt,
          updatedAt: createdAt,
        });
        getLogger().info("team desktop reserved", { botId, displayIndex });
        return {
          botId,
          displayIndex,
          state: "reserved",
          lastUsedAt: null,
        };
      } catch (error) {
        if (!isUniqueConflict(error)) throw scrubbed(error, [ownerToken]);
        const winner = await store.getByBot(botId);
        if (winner) return toStatus(winner);
      }
    }
    throw new TeamDesktopExhaustedError();
  }

  async function ensureBody(botId: string): Promise<TeamDesktopBinding> {
    let row = await store.getByBot(botId);
    if (!row) {
      if (members && !(await members()).includes(botId)) {
        throw new TeamDesktopMissingError(botId);
      }
      await reserveBody(botId);
      row = await requireRow(botId);
    } else {
      assertTeamDesktopIndex(row.displayIndex);
    }
    if (row.state === "releasing") {
      throw new TeamDesktopError("Team desktop is being released.");
    }
    await makeRoom(botId);
    const current = await requireRow(botId);
    let cardState = current.state;
    if (!(await alive(current.displayIndex))) {
      if (cardState !== "booting") {
        await store.update(botId, { state: "booting" });
        notifyCard(botId, cardState, "booting");
        cardState = "booting";
      }
      try {
        await host.cleanWindow(current.displayIndex);
        await host.startWindow(current.displayIndex, current.ownerToken);
        const started = now().getTime();
        while (!(await alive(current.displayIndex))) {
          if (now().getTime() - started >= ensureTimeoutMs) {
            throw new TeamDesktopError(
              `Team desktop ${current.displayIndex} did not become ready.`,
            );
          }
          await sleep(pollMs);
        }
      } catch (error) {
        await store.update(botId, { state: "stopped" });
        notifyCard(botId, "booting", "stopped");
        throw scrubbed(error, [current.ownerToken]);
      }
    }
    const usedAt = now();
    await store.update(botId, { state: "running", lastUsedAt: usedAt });
    notifyCard(botId, cardState, "running");
    getLogger().info("team desktop running", { botId, displayIndex: current.displayIndex });
    return { displayIndex: current.displayIndex, ownerToken: current.ownerToken };
  }

  async function makeRoom(botId: string): Promise<void> {
    const busy = await currentBusy();
    await releaseFinishedRuns(busy);
    const rows = await store.list();
    const self = rows.find((row) => row.botId === botId);
    if (self && holdsRunningSlot(self.state)) return;
    while (true) {
      const running = (await store.list()).filter(
        (row) => holdsRunningSlot(row.state) && row.botId !== botId,
      );
      if (running.length < maxRunning) return;
      const idle = running
        .filter((row) => !busy.has(row.botId) && isIdle(row))
        .sort((a, b) => (a.lastUsedAt?.getTime() ?? 0) - (b.lastUsedAt?.getTime() ?? 0));
      const victim = idle[0];
      if (!victim) throw new TeamDesktopLimitError(maxRunning);
      await stopBody(victim.botId);
    }
  }

  async function markStopped(row: TeamDesktopRecord): Promise<void> {
    try {
      await host.stopWindow(row.displayIndex);
    } catch (error) {
      getLogger().error(
        "team desktop stop for a dead window failed",
        scrubbed(error, [row.ownerToken]),
      );
    }
    try {
      await host.cleanWindow(row.displayIndex);
    } catch (error) {
      getLogger().error(
        "team desktop orphan cleanup for a dead window failed",
        scrubbed(error, [row.ownerToken]),
      );
    }
    try {
      await host.purge(row.displayIndex);
    } catch (error) {
      getLogger().error(
        "team desktop purge for a dead window failed",
        scrubbed(error, [row.ownerToken]),
      );
    }
    await store.update(row.botId, { state: "stopped" });
    notifyCard(row.botId, row.state, "stopped");
    getLogger().info("team desktop stopped", { botId: row.botId, displayIndex: row.displayIndex });
  }

  async function stopBody(botId: string): Promise<TeamDesktopStatus | null> {
    const row = await store.getByBot(botId);
    if (!row) return null;
    if (!inRange(row.displayIndex)) {
      getLogger().error("team desktop row is outside 101-150", {
        botId,
        displayIndex: row.displayIndex,
      });
      return toStatus(row);
    }
    try {
      await host.stopWindow(row.displayIndex);
      await host.cleanWindow(row.displayIndex);
      await host.purge(row.displayIndex);
    } catch (error) {
      throw scrubbed(error, [row.ownerToken]);
    }
    await store.update(botId, { state: "stopped" });
    notifyCard(botId, row.state, "stopped");
    getLogger().info("team desktop stopped", { botId, displayIndex: row.displayIndex });
    return toStatus({ ...row, state: "stopped" });
  }

  async function releaseBody(botId: string): Promise<void> {
    const row = await store.getByBot(botId);
    if (!row) return;
    await store.update(botId, { state: "releasing" });
    if (inRange(row.displayIndex)) {
      try {
        await host.stopWindow(row.displayIndex);
      } catch (error) {
        getLogger().error(
          "team desktop stop during release failed",
          scrubbed(error, [row.ownerToken]),
        );
      }
      try {
        await host.cleanWindow(row.displayIndex);
      } catch (error) {
        getLogger().error(
          "team desktop orphan cleanup during release failed",
          scrubbed(error, [row.ownerToken]),
        );
      }
      try {
        await host.purge(row.displayIndex);
      } catch (error) {
        getLogger().error(
          "team desktop purge during release failed",
          scrubbed(error, [row.ownerToken]),
        );
      }
    }
    await store.delete(botId);
    getLogger().info("team desktop released", { botId, displayIndex: row.displayIndex });
  }

  async function syncBody(memberBotIds: readonly string[]): Promise<void> {
    const wanted = new Set(memberBotIds);
    const rows = await store.list();
    for (const row of rows) {
      if (wanted.has(row.botId)) continue;
      try {
        await releaseBody(row.botId);
      } catch (error) {
        getLogger().error(
          "team desktop release during membership sync failed",
          scrubbed(error, [row.ownerToken]),
        );
      }
    }
    const held = new Set((await store.list()).map((row) => row.botId));
    const skipped: string[] = [];
    for (const botId of wanted) {
      if (held.has(botId)) continue;
      try {
        await reserveBody(botId);
      } catch (error) {
        if (!(error instanceof TeamDesktopExhaustedError)) throw error;
        skipped.push(botId);
      }
    }
    if (skipped.length > 0) {
      getLogger().warn("team desktop band is full; extra members stay without a row", {
        skipped: skipped.length,
      });
    }
  }

  async function noteDisplayGoneBody(displayIndex: number): Promise<void> {
    if (!inRange(displayIndex)) return;
    // Recreated during the watch debounce: the display is back.
    if (await host.xSocketExists(displayIndex)) return;
    const row = (await store.list()).find((candidate) => candidate.displayIndex === displayIndex);
    // Reserved, releasing, or already stopped. A stop already ran the cleanup.
    if (!row || (row.state !== "running" && row.state !== "booting")) return;
    await markStopped(row);
  }

  async function sweepMissingDisplaysBody(): Promise<void> {
    for (const row of await store.list()) {
      if (!inRange(row.displayIndex)) continue;
      if (row.state !== "running" && row.state !== "booting") continue;
      const socket = await host.xSocketExists(row.displayIndex);
      if (socket && (await alive(row.displayIndex))) continue;
      await markStopped(row);
    }
  }

  async function reconcileBody(): Promise<void> {
    lastReconcileAt = now().getTime();
    if (members) await syncBody(await members());
    try {
      await host.cleanOrphans();
    } catch (error) {
      getLogger().error("team desktop orphan session cleanup failed", scrubbed(error, []));
    }
    const rows = await store.list();
    const held = new Set<number>();
    for (const row of rows) {
      if (inRange(row.displayIndex)) held.add(row.displayIndex);
    }
    for (
      let displayIndex = TEAM_DESKTOP_MIN_INDEX;
      displayIndex <= TEAM_DESKTOP_MAX_INDEX;
      displayIndex += 1
    ) {
      if (held.has(displayIndex)) continue;
      if (!(await occupied(displayIndex))) continue;
      try {
        await host.stopWindow(displayIndex);
        await host.cleanWindow(displayIndex);
        await host.purge(displayIndex);
        getLogger().info("team desktop orphan reaped", { displayIndex });
      } catch (error) {
        getLogger().error("team desktop orphan reap failed", scrubbed(error, []));
      }
    }
    const busy = await currentBusy();
    await releaseFinishedRuns(busy);
    const cutoff = idleCutoff();
    for (const row of await store.list()) {
      if (!inRange(row.displayIndex)) continue;
      if (row.state === "releasing") {
        await releaseBody(row.botId);
        continue;
      }
      if (row.state === "booting") {
        if (busy.has(row.botId)) continue;
        if (await alive(row.displayIndex)) {
          await store.update(row.botId, { state: "running", lastUsedAt: now() });
          notifyCard(row.botId, "booting", "running");
        } else {
          await markStopped(row);
        }
        continue;
      }
      if (row.state !== "running") continue;
      const live = await alive(row.displayIndex);
      if (!live) {
        await markStopped(row);
        continue;
      }
      if (busy.has(row.botId)) continue;
      if ((row.lastUsedAt?.getTime() ?? 0) <= cutoff) await stopBody(row.botId);
    }
  }

  async function currentBusy(): Promise<Set<string>> {
    if (!activeRuns) return new Set();
    return new Set(await activeRuns());
  }

  /** A run that just ended starts its idle clock now, not from the last tool call. */
  async function releaseFinishedRuns(busy: ReadonlySet<string>): Promise<void> {
    if (!activeRuns) return;
    const finishedAt = now();
    for (const botId of watchedRuns) {
      if (busy.has(botId)) continue;
      const row = await store.getByBot(botId);
      if (row && row.state !== "releasing") await store.update(botId, { lastUsedAt: finishedAt });
    }
    watchedRuns.clear();
    for (const botId of busy) watchedRuns.add(botId);
  }

  async function pickIndex(): Promise<number> {
    const held = new Set((await store.list()).map((row) => row.displayIndex));
    for (
      let displayIndex = TEAM_DESKTOP_MIN_INDEX;
      displayIndex <= TEAM_DESKTOP_MAX_INDEX;
      displayIndex += 1
    ) {
      if (held.has(displayIndex)) continue;
      if (await host.xSocketExists(displayIndex)) continue;
      if (await host.tokenFileExists(displayIndex)) continue;
      const ports = teamDesktopPorts(displayIndex);
      if (await host.portListening(ports.cdp)) continue;
      if (await host.portListening(ports.exec)) continue;
      if (await host.portListening(ports.vnc)) continue;
      if (await host.portListening(ports.pty)) continue;
      return displayIndex;
    }
    throw new TeamDesktopExhaustedError();
  }

  /**
   * An unheld index still needs a stop when the host has claimed it. The token
   * file and exec port can exist without an X socket, so they are not the
   * disappearance signal the socket watch uses.
   */
  async function occupied(displayIndex: number): Promise<boolean> {
    if (await host.xSocketExists(displayIndex)) return true;
    if (await host.tokenFileExists(displayIndex)) return true;
    return host.portListening(teamDesktopPorts(displayIndex).exec);
  }

  async function alive(displayIndex: number): Promise<boolean> {
    try {
      return await host.windowAlive(displayIndex);
    } catch (error) {
      getLogger().error("team desktop liveness check failed", scrubbed(error, []));
      return false;
    }
  }

  async function requireRow(botId: string): Promise<TeamDesktopRecord> {
    const row = await store.getByBot(botId);
    if (!row) throw new TeamDesktopMissingError(botId);
    assertTeamDesktopIndex(row.displayIndex);
    return row;
  }
}

export function createPrismaTeamDesktopStore(prisma: PrismaClient): TeamDesktopStore {
  return {
    async getByBot(botId) {
      const row = await prisma.teamDesktop.findUnique({ where: { botId } });
      return row ? toRecord(row) : null;
    },
    async list() {
      const rows = await prisma.teamDesktop.findMany();
      return rows.map(toRecord);
    },
    async insert(row) {
      try {
        await prisma.teamDesktop.create({ data: row });
      } catch (error) {
        if (isUniqueConflict(error)) throw new TeamDesktopConflictError();
        throw error;
      }
    },
    async update(botId, patch) {
      await prisma.teamDesktop.update({ where: { botId }, data: patch });
    },
    async delete(botId) {
      await prisma.teamDesktop.deleteMany({ where: { botId } });
    },
  };
}

/** Bots whose run is still in progress. The idle reaper treats these desktops as in use. */
export async function listTeamDesktopActiveRunBotIds(prisma: PrismaClient): Promise<string[]> {
  const rows = await prisma.run.findMany({
    where: { status: { in: [...ACTIVE_RUN_STATUSES] } },
    select: { botId: true },
    distinct: ["botId"],
  });
  return rows.map((row) => row.botId);
}

/** Non-archived team-computer bots, excluding Hub roster mirrors. Does not read chat groups. */
export async function listTeamBMemberBotIds(prisma: PrismaClient): Promise<string[]> {
  const rows = await prisma.bot.findMany({
    where: teamDesktopMemberBotWhere(),
    select: { id: true },
  });
  return rows.map((row) => row.id);
}

/**
 * Reserve current members and release everyone else. Does not start windows.
 * A full 101–150 band logs a warning and leaves the extra members without a row.
 */
export async function syncTeamBDesktops(
  prisma: PrismaClient,
  desktops: Pick<TeamDesktopAllocator, "syncMembership">,
): Promise<void> {
  await desktops.syncMembership(await listTeamBMemberBotIds(prisma));
}

function toStatus(row: TeamDesktopRecord): TeamDesktopStatus {
  return {
    botId: row.botId,
    displayIndex: row.displayIndex,
    state: row.state,
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
  };
}

function toRecord(row: {
  botId: string;
  displayIndex: number;
  ownerToken: string;
  state: string;
  lastUsedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}): TeamDesktopRecord {
  return {
    botId: row.botId,
    displayIndex: row.displayIndex,
    ownerToken: row.ownerToken,
    state: parseState(row.state),
    lastUsedAt: row.lastUsedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function parseState(state: string): TeamDesktopState {
  if (
    state === "reserved" ||
    state === "booting" ||
    state === "running" ||
    state === "stopped" ||
    state === "releasing"
  ) {
    return state;
  }
  throw new TeamDesktopError("Team desktop state is invalid.");
}

function inRange(displayIndex: number): boolean {
  return displayIndex >= TEAM_DESKTOP_MIN_INDEX && displayIndex <= TEAM_DESKTOP_MAX_INDEX;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value?.trim());
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function isUniqueConflict(error: unknown): boolean {
  return (
    error instanceof TeamDesktopConflictError ||
    (typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === "P2002")
  );
}

function scrubbed(error: unknown, secrets: readonly string[]): Error {
  const message = error instanceof Error ? error.message : "team desktop operation failed";
  const wrapped = new TeamDesktopError(scrubSecrets(message, secrets));
  if (error instanceof Error && error.stack) {
    wrapped.stack = scrubSecrets(error.stack, secrets);
  }
  return wrapped;
}

function scrubSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length < 8) continue;
    out = out.split(secret).join("[redacted]");
  }
  return out;
}

/**
 * Tell the open thread that this bot's desktop changed. The payload is only the
 * card state. No display index and no owner token.
 */
export async function publishTeamDesktopComputerStatus(
  prisma: PrismaClient,
  events: {
    append(input: {
      spaceId: string;
      threadId: string;
      botId: string;
      type: "computer.status";
      payload: { status: TeamDesktopCardState };
    }): Promise<unknown>;
  },
  botId: string,
  state: TeamDesktopCardState,
): Promise<void> {
  try {
    const bot = await prisma.bot.findUnique({
      where: { id: botId },
      select: { spaceId: true, thread: { select: { id: true } } },
    });
    if (!bot?.thread) return;
    await events.append({
      spaceId: bot.spaceId,
      threadId: bot.thread.id,
      botId,
      type: "computer.status",
      payload: { status: state },
    });
  } catch (error) {
    getLogger().error("team desktop status event failed", error);
  }
}
