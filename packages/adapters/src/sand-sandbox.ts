import type {
  AdapterContext,
  CommandRequest,
  ComputerAction,
  ComputerActionRequest,
  ComputerFileEntry,
  ComputerInput,
  ComputerObservation,
  ComputerRef,
  ControlLeaseRef,
  PortableFile,
  ProcessEvent,
  SandboxProvider,
  ScreenRequest,
  ScreenSession,
} from "@rakazo/adapter-kit";
import { boundedSandboxCommandTimeoutMs } from "@rakazo/core";
import {
  boundedComputerActions,
  computerObservation,
  normalizeWorkspacePath,
} from "./computer-support.js";
import { SAND_HAND_REFUSAL, sandHandRefuses } from "./sand-hand.js";
import type { SandComputerAction, SandDirectoryEntry, SandHost } from "./sand-host.js";
import {
  isDirectoryReadError,
  isSandListDirectoryDenied,
  SandHostError,
  SandPathIsDirectoryError,
  sandExecEnv,
  sandImageMeta,
} from "./sand-host.js";
import type { SandSeatPolicy } from "./sand-seat.js";
import {
  requireSandSeat,
  SandDisplayForbiddenError,
  sandScreenSelectsForbiddenDisplay,
} from "./sand-seat.js";

/** Shared pod workspace for every sand window. Not a Team B container home. */
export const SAND_WORKSPACE = "/workspace";

export class SandSandboxProvider implements SandboxProvider {
  constructor(
    private readonly opts: {
      policy: SandSeatPolicy;
      host: SandHost;
    },
  ) {}

  describe() {
    return {
      id: "sand",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: {
        graphical: true,
        pty: false,
        snapshots: false,
        takeover: false,
        persistentHome: true,
        multiScreen: false,
      },
    };
  }

  async provision(
    request: {
      botId: string;
      homePath: string;
      providerRef?: string;
      providerKind?: ComputerRef["kind"];
    },
    context: AdapterContext,
  ): Promise<ComputerRef> {
    const seat = requireSandSeat(this.opts.policy, {
      botId: request.botId,
      callerBotId: context.botId,
      providerRef: request.providerRef,
    });
    return {
      id: `sand:${seat.agentId}`,
      botId: request.botId,
      kind: "sand",
      providerRef: seat.agentId,
      fresh: false,
    };
  }

  async prepare(computer: ComputerRef, context: AdapterContext): Promise<void> {
    const seat = this.seat(computer, context);
    await this.opts.host.capabilities(seat.agentId, context.signal);
  }

  async *execute(
    computer: ComputerRef,
    request: CommandRequest,
    context: AdapterContext,
  ): AsyncIterable<ProcessEvent> {
    const seat = this.seat(computer, context);
    if (request.argv.length === 0) {
      yield { type: "stderr", data: "sand exec requires a command\n" };
      yield { type: "exit", code: 1 };
      return;
    }
    const cwd = sandWorkspacePath(request.cwd);
    const timeoutMs = boundedSandboxCommandTimeoutMs(request.timeoutMs);
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = AbortSignal.any([context.signal, timeout]);
    try {
      yield* this.opts.host.exec(
        seat.agentId,
        { argv: request.argv, cwd, env: sandExecEnv(request.env), timeoutMs },
        signal,
      );
    } catch (error) {
      if (context.signal.aborted) {
        yield { type: "exit", code: 130 };
        return;
      }
      if (timeout.aborted) {
        yield { type: "stderr", data: `command timed out after ${timeoutMs} ms\n` };
        yield { type: "exit", code: 124 };
        return;
      }
      const message = error instanceof Error ? error.message : "sand exec failed";
      yield { type: "stderr", data: `${message}\n` };
      yield { type: "exit", code: 1 };
    }
  }

  async connectScreen(
    computer: ComputerRef,
    _request: ScreenRequest,
    context: AdapterContext,
  ): Promise<ScreenSession> {
    const seat = this.seat(computer, context);
    const url = this.opts.host.screenUrl(seat.agentId);
    if (url && sandScreenSelectsForbiddenDisplay(url)) throw new SandDisplayForbiddenError();
    return { url, mimeType: "text/html", close: async () => undefined };
  }

  async sendInput(
    computer: ComputerRef,
    input: ComputerInput,
    _lease: ControlLeaseRef,
    context: AdapterContext,
  ): Promise<void> {
    const seat = this.seat(computer, context);
    await this.opts.host.computerUse(seat.agentId, [toSandAction(input)], context.signal);
  }

  async observe(computer: ComputerRef, context: AdapterContext): Promise<ComputerObservation> {
    const seat = this.seat(computer, context);
    const result = await this.opts.host.computerUse(
      seat.agentId,
      [{ screenshot: {} }],
      context.signal,
    );
    return observationFrom(result.screenshot, result.cursor);
  }

  async act(computer: ComputerRef, request: ComputerActionRequest, context: AdapterContext) {
    const seat = this.seat(computer, context);
    const actions = boundedComputerActions(request.actions).map(toSandAction);
    const sent = request.observe === false ? actions : [...actions, { screenshot: {} }];
    const result = await this.opts.host.computerUse(seat.agentId, sent, context.signal);
    return {
      completed: actions.length,
      ...(request.observe === false
        ? {}
        : { observation: observationFrom(result.screenshot, result.cursor) }),
    };
  }

  async listFiles(
    computer: ComputerRef,
    directory: string,
    context: AdapterContext,
  ): Promise<ComputerFileEntry[]> {
    const seat = this.seat(computer, context);
    const absolute = sandWorkspacePath(directory);
    const entries = await listSandDirectory(this.opts.host, seat.agentId, absolute, context.signal);
    return entries.flatMap((entry) => {
      if (entry.type === "SYMLINK") return [];
      const child = entry.path.startsWith("/")
        ? sandWorkspacePath(entry.path)
        : sandWorkspacePath(`${absolute}/${entry.name}`);
      return [
        {
          path: workspaceRelative(child),
          kind: entry.type === "DIRECTORY" ? "dir" : "file",
          size: entry.sizeBytes,
        },
      ];
    });
  }

  async readFile(
    computer: ComputerRef,
    path: string,
    context: AdapterContext,
    options?: { maxBytes?: number },
  ): Promise<Uint8Array> {
    const seat = this.seat(computer, context);
    const bytes = await this.readAbsolute(seat.agentId, sandWorkspacePath(path), context.signal);
    if (options?.maxBytes !== undefined && bytes.byteLength > options.maxBytes) {
      throw new Error("file exceeds maxBytes");
    }
    return bytes;
  }

  async writeFile(computer: ComputerRef, file: PortableFile, context: AdapterContext) {
    const seat = this.seat(computer, context);
    const absolute = sandWorkspacePath(file.path);
    await this.opts.host.writeFile(seat.agentId, absolute, file.content, context.signal);
    if (file.executable) {
      await drainExec(this.opts.host, seat.agentId, ["chmod", "+x", absolute], context.signal);
    }
  }

  async *exportWorkspace(
    computer: ComputerRef,
    context: AdapterContext,
  ): AsyncIterable<PortableFile> {
    const seat = this.seat(computer, context);
    const files = await this.listTree(seat.agentId, SAND_WORKSPACE, context.signal);
    for (const file of files) {
      try {
        yield {
          path: file.path,
          content: await this.readAbsolute(
            seat.agentId,
            sandWorkspacePath(file.path),
            context.signal,
          ),
        };
      } catch (error) {
        if (error instanceof SandPathIsDirectoryError) continue;
        throw error;
      }
    }
  }

  async importWorkspace(
    computer: ComputerRef,
    files: AsyncIterable<PortableFile>,
    context: AdapterContext,
  ) {
    for await (const file of files) await this.writeFile(computer, file, context);
  }

  async snapshot(computer: ComputerRef, context: AdapterContext) {
    const seat = this.seat(computer, context);
    return {
      id: `sand-workspace-${seat.agentId}`,
      createdAt: new Date().toISOString(),
    };
  }

  async stop(_computer: ComputerRef, _context: AdapterContext): Promise<void> {}

  async destroy(_computer: ComputerRef, _context: AdapterContext): Promise<void> {}

  private async readAbsolute(agentId: string, absolute: string, signal: AbortSignal) {
    if (await this.pathIsDirectory(agentId, absolute, signal)) throw new SandPathIsDirectoryError();
    try {
      return await this.opts.host.readFile(agentId, absolute, signal);
    } catch (error) {
      if (await this.readFailedBecauseDirectory(agentId, absolute, signal, error)) {
        throw new SandPathIsDirectoryError();
      }
      throw error;
    }
  }

  /** A ReadBinaryFile 400 on a listable path is a directory, not a failed file read. */
  private async readFailedBecauseDirectory(
    agentId: string,
    absolute: string,
    signal: AbortSignal,
    error: unknown,
  ) {
    if (isDirectoryReadError(error)) return true;
    if (!(error instanceof SandHostError) || error.status !== 400) return false;
    try {
      await listSandDirectory(this.opts.host, agentId, absolute, signal);
      return true;
    } catch {
      return false;
    }
  }

  /** A listed directory is not passed to ReadBinaryFile. */
  private async pathIsDirectory(agentId: string, absolute: string, signal: AbortSignal) {
    if (absolute === SAND_WORKSPACE) return true;
    const slash = absolute.lastIndexOf("/");
    const parent = absolute.slice(0, slash) || SAND_WORKSPACE;
    const name = absolute.slice(slash + 1);
    let entries: SandDirectoryEntry[];
    try {
      entries = await listSandDirectory(this.opts.host, agentId, parent, signal);
    } catch {
      return false;
    }
    const entry = entries.find((item) => item.name === name || item.path === absolute);
    return entry?.type === "DIRECTORY";
  }

  private seat(computer: ComputerRef, context: AdapterContext) {
    return requireSandSeat(this.opts.policy, {
      botId: computer.botId,
      callerBotId: context.botId,
      providerRef: computer.providerRef,
    });
  }

  private async listTree(
    agentId: string,
    directory: string,
    signal: AbortSignal,
  ): Promise<ComputerFileEntry[]> {
    const entries = await listSandDirectory(this.opts.host, agentId, directory, signal);
    const files: ComputerFileEntry[] = [];
    for (const entry of entries) {
      if (entry.type === "SYMLINK") continue;
      const absolute = entry.path.startsWith("/")
        ? sandWorkspacePath(entry.path)
        : sandWorkspacePath(`${directory}/${entry.name}`);
      if (entry.type === "DIRECTORY") {
        files.push(...(await this.listTree(agentId, absolute, signal)));
        continue;
      }
      files.push({ path: workspaceRelative(absolute), kind: "file", size: entry.sizeBytes });
    }
    return files;
  }
}

export function sandWorkspacePath(input: string | undefined): string {
  const trimmed = input?.trim() || SAND_WORKSPACE;
  if (trimmed === SAND_WORKSPACE) return SAND_WORKSPACE;
  const relative = trimmed.startsWith(`${SAND_WORKSPACE}/`)
    ? trimmed.slice(SAND_WORKSPACE.length + 1)
    : trimmed;
  if (relative.startsWith("/")) throw new Error("path is outside the sand workspace");
  const normalized = normalizeWorkspacePath(relative);
  return normalized ? `${SAND_WORKSPACE}/${normalized}` : SAND_WORKSPACE;
}

/**
 * ListDirectory fails the whole RPC when any child lstat returns EACCES, which
 * Connect exposes as HTTP 403. A readable-but-not-searchable directory still
 * lists through `ls --file-type` on the same seat (readdir plus d_type).
 * A directory that ls cannot open rethrows the original 403.
 */
async function listSandDirectory(
  host: SandHost,
  agentId: string,
  absolute: string,
  signal: AbortSignal,
): Promise<SandDirectoryEntry[]> {
  try {
    return await host.listDirectory(agentId, absolute, signal);
  } catch (error) {
    if (!isSandListDirectoryDenied(error)) throw error;
    const listed = await listDirectoryWithLs(host, agentId, absolute, signal);
    if (!listed) throw error;
    return listed;
  }
}

async function listDirectoryWithLs(
  host: SandHost,
  agentId: string,
  absolute: string,
  signal: AbortSignal,
): Promise<SandDirectoryEntry[] | undefined> {
  let stdout = "";
  let code: number | undefined;
  for await (const event of host.exec(
    agentId,
    {
      argv: ["ls", "-1", "--file-type", "--", absolute],
      cwd: SAND_WORKSPACE,
      env: {},
      timeoutMs: boundedSandboxCommandTimeoutMs(undefined),
    },
    signal,
  )) {
    if (event.type === "stdout") stdout += event.data;
    if (event.type === "exit") code = event.code;
  }
  if (code !== 0) return undefined;
  return parseLsFileTypeListing(absolute, stdout);
}

function parseLsFileTypeListing(directory: string, stdout: string): SandDirectoryEntry[] {
  const root = directory.endsWith("/") ? directory.slice(0, -1) : directory;
  const entries: SandDirectoryEntry[] = [];
  for (const raw of stdout.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (!line) continue;
    const suffix = line.at(-1);
    const marked =
      suffix === "/" || suffix === "@" || suffix === "|" || suffix === "=" || suffix === ">";
    const name = marked ? line.slice(0, -1) : line;
    if (!name || name === "." || name === "..") continue;
    const type: SandDirectoryEntry["type"] =
      suffix === "/" ? "DIRECTORY" : suffix === "@" ? "SYMLINK" : "FILE";
    entries.push({ name, path: `${root}/${name}`, type, sizeBytes: 0 });
  }
  entries.sort((a, b) => {
    if (a.type === "DIRECTORY" && b.type !== "DIRECTORY") return -1;
    if (a.type !== "DIRECTORY" && b.type === "DIRECTORY") return 1;
    return a.name.localeCompare(b.name);
  });
  return entries;
}

function workspaceRelative(absolute: string): string {
  if (absolute === SAND_WORKSPACE) return "";
  return absolute.startsWith(`${SAND_WORKSPACE}/`)
    ? absolute.slice(SAND_WORKSPACE.length + 1)
    : absolute;
}

function toSandAction(action: ComputerAction): SandComputerAction {
  if (action.kind === "pointer") {
    const coordinate = { x: Math.round(action.x), y: Math.round(action.y) };
    const button = action.button === "right" ? "RIGHT" : "LEFT";
    if (action.type === "move") return { mouseMove: { coordinate } };
    if (action.type === "down") return { mouseDown: { coordinate, button } };
    if (action.type === "up") return { mouseUp: { coordinate, button } };
    return { click: { coordinate, button, count: 1 } };
  }
  if (action.kind === "key") {
    const key = action.modifiers?.length
      ? `${action.modifiers.join("+")}+${action.key}`
      : action.key;
    return { key: { key } };
  }
  if (action.kind === "clipboard") return { type: { text: action.text } };
  if (action.kind === "scroll") {
    return {
      scroll: {
        direction: action.direction === "up" ? "UP" : "DOWN",
        amount: action.amount ?? 3,
      },
    };
  }
  if (action.kind === "wait") return { wait: { durationMs: Math.max(0, Math.round(action.ms)) } };
  if (sandHandRefuses(action.kind)) throw new Error(SAND_HAND_REFUSAL);
  throw new Error(`sand computer use does not support ${action.kind}`);
}

function observationFrom(
  screenshot: Uint8Array | undefined,
  cursor: { x: number; y: number } | undefined,
): ComputerObservation {
  if (!screenshot || screenshot.byteLength === 0) {
    throw new Error("sand computer use did not return a screenshot");
  }
  const image = sandImageMeta(screenshot);
  return computerObservation(screenshot, {
    mimeType: image.mimeType,
    width: image.width,
    height: image.height,
    ...(cursor ? { cursor } : {}),
  });
}

async function drainExec(
  host: SandHost,
  agentId: string,
  argv: string[],
  signal: AbortSignal,
): Promise<void> {
  let stderr = "";
  let code = 0;
  for await (const event of host.exec(
    agentId,
    { argv, cwd: SAND_WORKSPACE, timeoutMs: boundedSandboxCommandTimeoutMs(undefined), env: {} },
    signal,
  )) {
    if (event.type === "stderr") stderr += event.data;
    if (event.type === "exit") code = event.code;
  }
  if (code !== 0) throw new Error(stderr.trim() || `sand exec failed: ${code}`);
}
