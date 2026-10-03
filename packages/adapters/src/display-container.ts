import type { ChildProcess, SpawnOptions } from "node:child_process";
import { spawn as nodeSpawn } from "node:child_process";
import { lstat, mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  AdapterContext,
  CommandRequest,
  ComputerActionRequest,
  ComputerFileEntry,
  ComputerInput,
  ComputerRef,
  ControlLeaseRef,
  PortableFile,
  ProcessEvent,
  SandboxProvider,
  ScreenRequest,
  TerminalRequest,
} from "@rakazo/adapter-kit";
import { boundedSandboxCommandTimeoutMs } from "@rakazo/core";
import { normalizeWorkspacePath } from "./computer-support.js";

/**
 * One bot on a space whose SANDBOX_PROVIDER stays fake.
 * The lab starts the container. This process only execs into it.
 * Team Computer.kind is shared, so a column on that row would move every bot.
 * DesktopSandboxProvider spawns on the host, so it is not this attachment.
 */
export interface DisplayContainerAttachment {
  botId: string;
  container: string;
  home: string;
}

/** Chief. Deputy and every other bot stay on the space provider. */
const DEFAULT_DISPLAY_CONTAINERS: readonly DisplayContainerAttachment[] = [
  {
    botId: "cmurhzv6600039g9hdhbizc35",
    container: "rakazo-display-chief",
    home: "/workspace/rakazo-stack/bot-homes/chief",
  },
];

const CONTAINER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

export type DisplaySpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

/**
 * When set, replaces the built-in attachment. An empty value attaches nobody.
 * Entries are `botId|container|home`, separated by commas.
 */
export function displayContainerAttachments(
  env: NodeJS.ProcessEnv = process.env,
): DisplayContainerAttachment[] {
  const configured = env.SANDBOX_DISPLAY_BOTS;
  if (configured === undefined) return DEFAULT_DISPLAY_CONTAINERS.map((entry) => ({ ...entry }));
  if (!configured.trim()) return [];
  return configured.split(",").map((entry) => parseDisplayAttachment(entry.trim()));
}

export function displayAttachmentForBot(
  botId: string | undefined,
  attachments: readonly DisplayContainerAttachment[],
): DisplayContainerAttachment | undefined {
  if (!botId) return undefined;
  return attachments.find((entry) => entry.botId === botId);
}

/** Team cwd `bots/<id>` is this container's home, not a shared computer root. */
export function displayWorkingDirectory(
  attachment: DisplayContainerAttachment,
  cwd: string | undefined,
): string {
  const home = stripTrailingSlash(attachment.home);
  if (!cwd || cwd === "." || cwd === "/home/rakazo" || cwd === "/home/user") return home;
  if (cwd === home || cwd.startsWith(`${home}/`)) {
    normalizeWorkspacePath(cwd === home ? "" : cwd.slice(home.length + 1));
    return cwd;
  }
  if (cwd.startsWith("/")) throw new Error("path is outside this computer's home");
  const relative = displayRelativePath(attachment.botId, cwd);
  return relative ? `${home}/${relative}` : home;
}

export function displayExecArgs(
  attachment: DisplayContainerAttachment,
  cwd: string,
  env: Record<string, string> | undefined,
  argv: readonly string[],
  timeoutMs: number,
): string[] {
  const args = ["exec", "-w", cwd];
  for (const [key, value] of Object.entries(env ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || key === "HOME" || key === "DISPLAY") continue;
    args.push("-e", `${key}=${value}`);
  }
  const seconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  args.push(
    "-e",
    `HOME=${attachment.home}`,
    "-e",
    "DISPLAY=:1",
    attachment.container,
    "timeout",
    "--kill-after=1s",
    `${seconds}s`,
    ...argv,
  );
  return args;
}

/**
 * Routes one bot's shell and files at a lab-started display container.
 * Every other bot keeps the space provider, including its fake echo stubs.
 * stop and destroy stay on that provider so this path never removes the container.
 */
export class DisplayContainerSandbox implements SandboxProvider {
  constructor(
    private readonly inner: SandboxProvider,
    private readonly attachments: readonly DisplayContainerAttachment[],
    private readonly spawnCommand: DisplaySpawn = nodeSpawn,
  ) {}

  describe() {
    return this.inner.describe();
  }

  provision(
    request: {
      botId: string;
      homePath: string;
      providerRef?: string;
      providerKind?: ComputerRef["kind"];
    },
    context: AdapterContext,
  ) {
    return this.inner.provision(request, context);
  }

  prepare(computer: ComputerRef, context: AdapterContext) {
    return this.inner.prepare(computer, context);
  }

  async *execute(
    computer: ComputerRef,
    request: CommandRequest,
    context: AdapterContext,
  ): AsyncIterable<ProcessEvent> {
    const attachment = displayAttachmentForBot(context.botId, this.attachments);
    if (!attachment) {
      yield* this.inner.execute(computer, request, context);
      return;
    }
    let cwd: string;
    try {
      cwd = displayWorkingDirectory(attachment, request.cwd);
    } catch (error) {
      yield {
        type: "stderr",
        data: error instanceof Error ? error.message : "path is outside this computer's home",
      };
      yield { type: "exit", code: 1 };
      return;
    }
    const argv = request.argv.length > 0 ? request.argv : ["echo", "ready"];
    yield* streamDockerExec(
      this.spawnCommand,
      attachment,
      cwd,
      request.env,
      argv,
      boundedSandboxCommandTimeoutMs(request.timeoutMs),
      context.signal,
    );
  }

  connectScreen(computer: ComputerRef, request: ScreenRequest, context: AdapterContext) {
    return this.inner.connectScreen(computer, request, context);
  }

  connectTerminal(computer: ComputerRef, request: TerminalRequest, context: AdapterContext) {
    if (!this.inner.connectTerminal) {
      return Promise.reject(new Error("terminal is unavailable on this computer"));
    }
    return this.inner.connectTerminal(computer, request, context);
  }

  sendInput(
    computer: ComputerRef,
    input: ComputerInput,
    lease: ControlLeaseRef,
    context: AdapterContext,
  ) {
    return this.inner.sendInput(computer, input, lease, context);
  }

  observe(computer: ComputerRef, context: AdapterContext) {
    return this.inner.observe(computer, context);
  }

  act(computer: ComputerRef, request: ComputerActionRequest, context: AdapterContext) {
    return this.inner.act(computer, request, context);
  }

  async listFiles(
    computer: ComputerRef,
    directory: string,
    context: AdapterContext,
  ): Promise<ComputerFileEntry[]> {
    const attachment = displayAttachmentForBot(context.botId, this.attachments);
    if (!attachment) return this.inner.listFiles(computer, directory, context);
    const relative = displayRelativePath(attachment.botId, directory);
    const target = await walkContained(await homeRoot(attachment.home), relative);
    const entries = await readdir(target, { withFileTypes: true });
    const listed: ComputerFileEntry[] = [];
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const child = path.join(target, entry.name);
      const info = await stat(child);
      const childPath = relative ? `${relative}/${entry.name}` : entry.name;
      listed.push({
        path: childPath,
        kind: info.isDirectory() ? "dir" : "file",
        size: info.size,
        ...(info.isFile() && info.mode & 0o111 ? { executable: true } : {}),
      });
    }
    return listed;
  }

  async readFile(
    computer: ComputerRef,
    filePath: string,
    context: AdapterContext,
    options?: { maxBytes?: number },
  ) {
    const attachment = displayAttachmentForBot(context.botId, this.attachments);
    if (!attachment) return this.inner.readFile(computer, filePath, context, options);
    const relative = displayRelativePath(attachment.botId, filePath);
    if (!relative) throw new Error("path is outside this computer's home");
    const target = await walkContained(await homeRoot(attachment.home), relative);
    const info = await stat(target);
    if (options?.maxBytes !== undefined && info.size > options.maxBytes) {
      throw new Error(`computer file exceeds ${options.maxBytes} bytes`);
    }
    return new Uint8Array(await readFile(target));
  }

  async writeFile(computer: ComputerRef, file: PortableFile, context: AdapterContext) {
    const attachment = displayAttachmentForBot(context.botId, this.attachments);
    if (!attachment) return this.inner.writeFile(computer, file, context);
    const target = await containedWritePath(
      attachment.home,
      displayRelativePath(attachment.botId, file.path),
    );
    await writeFile(target, file.content, { mode: file.executable ? 0o700 : 0o600 });
  }

  exportWorkspace(computer: ComputerRef, context: AdapterContext) {
    return this.inner.exportWorkspace(computer, context);
  }

  importWorkspace(
    computer: ComputerRef,
    files: AsyncIterable<PortableFile>,
    context: AdapterContext,
  ) {
    return this.inner.importWorkspace(computer, files, context);
  }

  snapshot(computer: ComputerRef, context: AdapterContext) {
    return this.inner.snapshot(computer, context);
  }

  stop(computer: ComputerRef, context: AdapterContext) {
    return this.inner.stop(computer, context);
  }

  destroy(computer: ComputerRef, context: AdapterContext) {
    return this.inner.destroy(computer, context);
  }

  keepAlive(computer: ComputerRef) {
    return this.inner.keepAlive?.(computer) ?? Promise.resolve();
  }

  releaseScreen(computer: ComputerRef, context: AdapterContext) {
    return this.inner.releaseScreen?.(computer, context) ?? Promise.resolve();
  }

  setScreenControl(
    computer: ComputerRef,
    interactive: boolean,
    context: AdapterContext,
    controlToken?: string,
  ) {
    return (
      this.inner.setScreenControl?.(computer, interactive, context, controlToken) ??
      Promise.resolve()
    );
  }

  inspectBackgroundWork(computer: ComputerRef, markerId: string, context: AdapterContext) {
    return (
      this.inner.inspectBackgroundWork?.(computer, markerId, context) ??
      Promise.resolve("unknown" as const)
    );
  }
}

function parseDisplayAttachment(entry: string): DisplayContainerAttachment {
  const [botId, container, home] = entry.split("|");
  if (!botId || !container || !home || entry.split("|").length !== 3) {
    throw new Error("SANDBOX_DISPLAY_BOTS entries are botId|container|home");
  }
  if (!CONTAINER_NAME.test(container)) throw new Error("display container name is invalid");
  if (!home.startsWith("/")) throw new Error("display home must be an absolute path");
  return { botId, container, home: stripTrailingSlash(home) };
}

function displayRelativePath(botId: string, requested: string | undefined): string {
  if (
    !requested ||
    requested === "." ||
    requested === "/home/rakazo" ||
    requested === "/home/user"
  ) {
    return "";
  }
  const normalized = normalizeWorkspacePath(requested);
  const botDir = `bots/${normalizeWorkspacePath(botId)}`;
  if (normalized === botDir) return "";
  if (normalized.startsWith(`${botDir}/`)) return normalized.slice(botDir.length + 1);
  return normalized;
}

function stripTrailingSlash(value: string): string {
  return value.length > 1 ? value.replace(/\/+$/, "") : value;
}

function isEnoent(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function homeRoot(home: string): Promise<string> {
  try {
    const root = await realpath(home);
    const info = await stat(root);
    if (!info.isDirectory()) throw new Error("display home is not available");
    return root;
  } catch (error) {
    if (isEnoent(error)) throw new Error("display home is not available");
    throw error;
  }
}

async function containedWritePath(home: string, relative: string): Promise<string> {
  const safe = normalizeWorkspacePath(relative);
  if (!safe) throw new Error("path is outside this computer's home");
  const root = await homeRoot(home);
  const segments = safe.split("/");
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    const next = path.join(current, segment);
    try {
      const info = await lstat(next);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new Error("path is outside this computer's home");
      }
    } catch (error) {
      if (!isEnoent(error)) throw error;
      await mkdir(next);
    }
    current = next;
  }
  const parent = await realpath(current);
  const rootReal = await realpath(root);
  if (parent !== rootReal && !parent.startsWith(`${rootReal}${path.sep}`)) {
    throw new Error("path is outside this computer's home");
  }
  const leaf = path.join(parent, segments.at(-1)!);
  try {
    const info = await lstat(leaf);
    if (info.isSymbolicLink()) throw new Error("path is outside this computer's home");
  } catch (error) {
    if (!isEnoent(error)) throw error;
  }
  return leaf;
}

async function walkContained(root: string, relative: string): Promise<string> {
  const segments = relative ? normalizeWorkspacePath(relative).split("/") : [];
  let current = root;
  for (const segment of segments) {
    if (!segment) continue;
    const next = path.join(current, segment);
    const info = await lstat(next);
    if (info.isSymbolicLink()) throw new Error("path is outside this computer's home");
    current = next;
  }
  return current;
}

function streamDockerExec(
  spawnCommand: DisplaySpawn,
  attachment: DisplayContainerAttachment,
  cwd: string,
  env: Record<string, string> | undefined,
  argv: readonly string[],
  timeoutMs: number,
  signal: AbortSignal,
): AsyncIterable<ProcessEvent> {
  const args = displayExecArgs(attachment, cwd, env, argv, timeoutMs);
  return streamChild(
    spawnCommand("docker", args, { stdio: ["ignore", "pipe", "pipe"] }),
    timeoutMs,
    signal,
  );
}

async function* streamChild(
  child: ChildProcess,
  timeoutMs: number,
  signal: AbortSignal,
): AsyncIterable<ProcessEvent> {
  const queue: ProcessEvent[] = [];
  let ended = false;
  let settled = false;
  let wake: (() => void) | undefined;
  const push = (event: ProcessEvent) => {
    queue.push(event);
    const notify = wake;
    wake = undefined;
    notify?.();
  };
  const finish = (code: number, stderrLine?: string) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    signal.removeEventListener("abort", abort);
    if (stderrLine)
      push({ type: "stderr", data: stderrLine.endsWith("\n") ? stderrLine : `${stderrLine}\n` });
    push({ type: "exit", code });
    ended = true;
    const notify = wake;
    wake = undefined;
    notify?.();
  };
  const abort = () => {
    child.kill("SIGTERM");
    finish(130, "command aborted");
  };
  const timeout = setTimeout(() => {
    child.kill("SIGTERM");
    finish(124, `command timed out after ${timeoutMs} ms`);
  }, timeoutMs);
  timeout.unref?.();
  signal.addEventListener("abort", abort, { once: true });
  child.stdout?.on("data", (chunk: Buffer | string) => {
    if (!settled) push({ type: "stdout", data: chunk.toString() });
  });
  child.stderr?.on("data", (chunk: Buffer | string) => {
    if (!settled) push({ type: "stderr", data: chunk.toString() });
  });
  child.on("error", (error) => finish(1, error.message));
  child.on("close", (code) => finish(code ?? 1));
  if (signal.aborted) abort();
  while (!ended || queue.length > 0) {
    if (queue.length === 0) {
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
      continue;
    }
    yield queue.shift()!;
  }
}
