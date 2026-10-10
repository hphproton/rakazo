import type { ProcessEvent } from "@rakazo/adapter-kit";
import { SandDisplayForbiddenError, sandScreenSelectsForbiddenDisplay } from "./sand-seat.js";
import { createStepSignal, withStepSignal } from "./step-signal.js";
import { TEAM_DESKTOP_ROUTER_URL, teamDesktopViewerUrl } from "./team-desktop.js";

/**
 * Header the sand-host router is assumed to use when it picks an agent's
 * exec-daemon. The router ignores this header. Team desktops send
 * `x-sand-display` and `x-sand-window-owner` instead.
 * This client does not call createAgent or ensureForeverBox.
 */
export const SAND_AGENT_HEADER = "x-sand-agent-id";
export const SAND_DISPLAY_HEADER = "x-sand-display";
export const SAND_WINDOW_OWNER_HEADER = "x-sand-window-owner";
export const SAND_HOST_DEFAULT_URL = "http://127.0.0.1:1339";

export interface SandWindowRoute {
  displayIndex: number;
  ownerToken: string;
}

const BLOCKED_EXEC_ENV = new Set(["DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY"]);

export interface SandDirectoryEntry {
  name: string;
  path: string;
  type: "FILE" | "DIRECTORY" | "SYMLINK";
  sizeBytes: number;
}

export interface SandExecRequest {
  argv: string[];
  cwd: string;
  env?: Record<string, string>;
  timeoutMs: number;
}

export interface SandComputerUseResult {
  screenshot?: Uint8Array;
  cursor?: { x: number; y: number };
}

export type SandComputerAction = Record<string, unknown>;

/** ConnectRPC surface the sand-host router fronts for one agent id. */
export interface SandHost {
  capabilities(agentId: string, signal: AbortSignal): Promise<{ computerUseSupported: boolean }>;
  exec(agentId: string, request: SandExecRequest, signal: AbortSignal): AsyncIterable<ProcessEvent>;
  listDirectory(agentId: string, path: string, signal: AbortSignal): Promise<SandDirectoryEntry[]>;
  readFile(agentId: string, path: string, signal: AbortSignal): Promise<Uint8Array>;
  writeFile(agentId: string, path: string, content: Uint8Array, signal: AbortSignal): Promise<void>;
  computerUse(
    agentId: string,
    actions: readonly SandComputerAction[],
    signal: AbortSignal,
  ): Promise<SandComputerUseResult>;
  /** Viewer URL reported for this agent. Null when the host did not name one. */
  screenUrl(agentId: string): string | null;
}

export class SandHostError extends Error {
  readonly status: number;

  constructor(service: string, method: string, status: number) {
    super(`sand ${service}/${method} failed: ${status}`);
    this.name = "SandHostError";
    this.status = status;
  }
}

/** Connect maps exec-daemon EACCES/EPERM to HTTP 403. */
export function isSandControlDenied(error: unknown): boolean {
  return error instanceof SandHostError && error.status === 403;
}

/**
 * ListDirectory 403 is a permission denial from readdir or from lstat of one
 * child. The directory may still be name-listable through Exec.
 */
export function isSandListDirectoryDenied(error: unknown): boolean {
  return (
    isSandControlDenied(error) && error instanceof Error && error.message.includes("ListDirectory")
  );
}

/** ReadBinaryFile refuses directories. Callers list or skip them instead. */
export class SandPathIsDirectoryError extends Error {
  constructor() {
    super("path is a directory");
    this.name = "SandPathIsDirectoryError";
  }
}

export function isDirectoryReadError(error: unknown): boolean {
  return (
    error instanceof SandPathIsDirectoryError ||
    (error instanceof Error && /EISDIR|is a directory/i.test(error.message))
  );
}

export function sandHostBaseUrl(value: string | undefined): string {
  const raw = value?.trim() || SAND_HOST_DEFAULT_URL;
  if (sandScreenSelectsForbiddenDisplay(raw)) throw new SandDisplayForbiddenError();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("SAND_HOST_URL is not a valid URL");
  }
  if (url.username || url.password) throw new Error("SAND_HOST_URL must not include credentials");
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("SAND_HOST_URL must be http or https");
  }
  url.search = "";
  url.hash = "";
  url.pathname = url.pathname.replace(/\/$/, "");
  return url.toString().replace(/\/$/, "");
}

export function sandExecEnv(env: Record<string, string> | undefined): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [key, value] of Object.entries(env ?? {})) {
    if (BLOCKED_EXEC_ENV.has(key)) continue;
    if (sandScreenSelectsForbiddenDisplay(value)) continue;
    kept[key] = value;
  }
  return kept;
}

/**
 * Absolute browser the Grok window daemon exports as `BROWSER`.
 * Team-desktop exec sets the same value. It does not add a PATH entry.
 */
export const SAND_TEAM_BROWSER = "/usr/local/bin/box-chrome";

/**
 * Exec environment for a team desktop. The window daemon already has `DISPLAY`
 * and merges its process environment under the request, so a request that
 * omits `BROWSER` still inherits box-chrome there. Setting it here keeps the
 * same absolute value when the caller did not. `PATH` is copied through unchanged.
 */
export function sandTeamExecEnv(env: Record<string, string> | undefined): Record<string, string> {
  const kept = sandExecEnv(env);
  if (!Object.hasOwn(kept, "BROWSER")) kept.BROWSER = SAND_TEAM_BROWSER;
  return kept;
}

export function sandImageMeta(bytes: Uint8Array): {
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  width: number;
  height: number;
} {
  if (isPng(bytes)) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { mimeType: "image/png", width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (isWebp(bytes)) {
    const size = webpSize(bytes);
    return { mimeType: "image/webp", width: size.width, height: size.height };
  }
  if (bytes.length > 2 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    return { mimeType: "image/jpeg", ...jpegSize(bytes) };
  }
  throw new Error("sand screenshot is not a png, jpeg, or webp image");
}

export class ConnectSandHost implements SandHost {
  private readonly baseUrl: string;
  private readonly token: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly display: SandWindowRoute | undefined;
  private nextId = 1;

  constructor(
    opts: {
      baseUrl?: string;
      token?: string;
      fetch?: typeof fetch;
      display?: SandWindowRoute;
    } = {},
  ) {
    this.display = opts.display;
    this.baseUrl = opts.display ? TEAM_DESKTOP_ROUTER_URL : sandHostBaseUrl(opts.baseUrl);
    this.token = opts.token?.trim() || undefined;
    this.fetchImpl = opts.fetch ?? fetch;
  }

  /** Same bearer and fetch, forced onto the display router. */
  withDisplay(display: SandWindowRoute): ConnectSandHost {
    return new ConnectSandHost({
      token: this.token,
      fetch: this.fetchImpl,
      display,
    });
  }

  screenUrl(_agentId: string): string | null {
    return this.display ? teamDesktopViewerUrl(this.display.displayIndex) : null;
  }

  async capabilities(agentId: string, signal: AbortSignal) {
    const body = await this.unary("ControlService", "GetCapabilities", agentId, {}, signal);
    const record = asRecord(body);
    return { computerUseSupported: record.computerUseSupported === true };
  }

  async *exec(
    agentId: string,
    request: SandExecRequest,
    signal: AbortSignal,
  ): AsyncIterable<ProcessEvent> {
    const [command, ...args] = request.argv;
    if (!command) throw new Error("sand exec requires a command");
    const env = sandExecEnv(request.env);
    // timeoutMs 0 means the caller already armed the deadline on `signal`.
    const step = createStepSignal(signal, request.timeoutMs > 0 ? request.timeoutMs : undefined);
    try {
      const response = await this.stream(
        "ControlService",
        "Exec",
        agentId,
        {
          command,
          args,
          cwd: request.cwd,
          ...(Object.keys(env).length > 0 ? { environment: env } : {}),
        },
        step.signal,
      );
      let exited = false;
      for await (const frame of readConnectJson(response, step.signal)) {
        const record = asRecord(frame);
        const stdout = nestedString(record, "stdoutEvent", "data");
        const stderr = nestedString(record, "stderrEvent", "data");
        if (stdout) yield { type: "stdout", data: stdout };
        if (stderr) yield { type: "stderr", data: stderr };
        if ("exitEvent" in record) {
          exited = true;
          yield { type: "exit", code: nestedNumber(record, "exitEvent", "exitCode") ?? 0 };
        }
      }
      if (!exited) yield { type: "exit", code: 0 };
    } catch (error) {
      if (step.timedOut && !signal.aborted) {
        yield { type: "stderr", data: `command timed out after ${request.timeoutMs} ms\n` };
        yield { type: "exit", code: 124 };
        return;
      }
      throw error;
    } finally {
      step.dispose();
    }
  }

  async listDirectory(agentId: string, path: string, signal: AbortSignal) {
    const body = await this.unary(
      "ControlService",
      "ListDirectory",
      agentId,
      { path, includeHidden: false },
      signal,
    );
    const entries = asRecord(body).entries;
    if (!Array.isArray(entries)) return [];
    return entries.map(parseDirectoryEntry);
  }

  async readFile(agentId: string, path: string, signal: AbortSignal) {
    const body = await this.unary("ControlService", "ReadBinaryFile", agentId, { path }, signal);
    const content = asRecord(body).content;
    if (typeof content !== "string" || content.length === 0) return new Uint8Array();
    return Uint8Array.from(Buffer.from(content, "base64"));
  }

  async writeFile(agentId: string, path: string, content: Uint8Array, signal: AbortSignal) {
    await this.unary(
      "ControlService",
      "WriteBinaryFile",
      agentId,
      { path, content: Buffer.from(content).toString("base64") },
      signal,
    );
  }

  async computerUse(
    agentId: string,
    actions: readonly SandComputerAction[],
    signal: AbortSignal,
  ): Promise<SandComputerUseResult> {
    const id = this.nextId;
    this.nextId += 1;
    return withStepSignal(signal, async (stepSignal) => {
      const response = await this.stream(
        "ExecService",
        "Exec",
        agentId,
        {
          id,
          execId: `sand-${id}`,
          computerUseArgs: {
            toolCallId: `sand-cu-${id}`,
            actions,
            desktopLeaseActorId: agentId,
          },
        },
        stepSignal,
      );
      let screenshot: string | undefined;
      let cursor: { x: number; y: number } | undefined;
      for await (const frame of readConnectJson(response, stepSignal)) {
        const result = computerUsePayload(frame);
        if (!result) continue;
        if (typeof result.error === "string" && result.error) {
          throw new Error(result.error.slice(0, 200));
        }
        if (typeof result.screenshot === "string") screenshot = result.screenshot;
        if (isCoordinate(result.cursorPosition)) cursor = result.cursorPosition;
      }
      return {
        ...(screenshot ? { screenshot: Uint8Array.from(Buffer.from(screenshot, "base64")) } : {}),
        ...(cursor ? { cursor } : {}),
      };
    });
  }

  private async unary(
    service: "ControlService" | "ExecService",
    method: string,
    agentId: string,
    body: unknown,
    signal: AbortSignal,
  ): Promise<unknown> {
    return withStepSignal(signal, async (stepSignal) => {
      const response = await this.request(
        service,
        method,
        agentId,
        "application/json",
        bodyBytes(JSON.stringify(body)),
        stepSignal,
      );
      const text = await response.text();
      if (!text) return {};
      return JSON.parse(text) as unknown;
    });
  }

  private async stream(
    service: "ControlService" | "ExecService",
    method: string,
    agentId: string,
    body: unknown,
    signal: AbortSignal,
  ): Promise<Response> {
    const payload = bodyBytes(JSON.stringify(body));
    const framed = new Uint8Array(5 + payload.length);
    framed.set(frameHeader(0, payload.length));
    framed.set(payload, 5);
    return this.request(service, method, agentId, "application/connect+json", framed, signal);
  }

  private async request(
    service: string,
    method: string,
    agentId: string,
    contentType: string,
    body: Uint8Array,
    signal: AbortSignal,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      "content-type": contentType,
      "connect-protocol-version": "1",
    };
    if (this.display) {
      headers[SAND_DISPLAY_HEADER] = String(this.display.displayIndex);
      headers[SAND_WINDOW_OWNER_HEADER] = this.display.ownerToken;
    } else {
      headers[SAND_AGENT_HEADER] = agentId;
    }
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/agent.v1.${service}/${method}`, {
        method: "POST",
        headers,
        body: copyBytes(body),
        redirect: "error",
        signal,
      });
    } catch (error) {
      throw scrubToken(error, this.token, this.display?.ownerToken);
    }
    if (!response.ok) {
      if (response.status === 400 && (await responseSaysDirectory(response))) {
        throw new SandPathIsDirectoryError();
      }
      throw new SandHostError(service, method, response.status);
    }
    return response;
  }
}

async function responseSaysDirectory(response: Response): Promise<boolean> {
  const text = await response.text().catch(() => "");
  return /EISDIR|is a directory/i.test(text.slice(0, 500));
}

function scrubToken(error: unknown, ...secrets: Array<string | undefined>): Error {
  if (!(error instanceof Error)) return new Error("sand host request failed");
  const hidden = secrets.some((secret) => secret && error.message.includes(secret));
  if (hidden) return new Error("sand host request failed");
  return error;
}

function bodyBytes(text: string): Uint8Array<ArrayBuffer> {
  return copyBytes(new TextEncoder().encode(text));
}

function copyBytes(value: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy;
}

function frameHeader(flags: number, length: number): Uint8Array {
  const header = new Uint8Array(5);
  header[0] = flags;
  new DataView(header.buffer).setUint32(1, length);
  return header;
}

async function* readConnectJson(response: Response, signal: AbortSignal): AsyncIterable<unknown> {
  if (!response.body) throw new Error("sand host returned an empty stream");
  const reader = response.body.getReader();
  let pending = Buffer.alloc(0);
  const pull = async () => {
    if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("aborted");
    const next = await reader.read();
    if (next.done) return false;
    pending = Buffer.concat([pending, Buffer.from(next.value)]);
    return true;
  };
  try {
    while (true) {
      while (pending.length < 5) {
        if (!(await pull())) {
          if (pending.length === 0) return;
          throw new Error("sand host closed before the Connect frame finished");
        }
      }
      const flags = pending[0] ?? 0;
      const length = pending.readUInt32BE(1);
      while (pending.length < 5 + length) {
        if (!(await pull())) throw new Error("sand host closed before the Connect frame finished");
      }
      const payload = pending.subarray(5, 5 + length);
      pending = pending.subarray(5 + length);
      if ((flags & 0x01) !== 0) throw new Error("compressed sand host frames are not supported");
      const text = payload.toString("utf8");
      const parsed: unknown = text ? (JSON.parse(text) as unknown) : {};
      const message = connectError(parsed);
      if (message) throw new Error(message);
      if ((flags & 0x02) !== 0) return;
      yield parsed;
    }
  } finally {
    reader.releaseLock();
  }
}

function connectError(value: unknown): string | undefined {
  const error = asRecord(value).error;
  const message = asRecord(error).message;
  return typeof message === "string" && message ? message.slice(0, 200) : undefined;
}

function parseDirectoryEntry(value: unknown): SandDirectoryEntry {
  const record = asRecord(value);
  const name = typeof record.name === "string" ? record.name : "";
  const path = typeof record.path === "string" && record.path ? record.path : name;
  return {
    name,
    path,
    type: entryType(record.type),
    sizeBytes: numberValue(record.sizeBytes) ?? 0,
  };
}

function entryType(value: unknown): SandDirectoryEntry["type"] {
  if (value === 2 || isEntryType(value, "DIRECTORY")) return "DIRECTORY";
  if (value === 3 || isEntryType(value, "SYMLINK")) return "SYMLINK";
  return "FILE";
}

/** Proto JSON emits `ENTRY_TYPE_DIRECTORY`; some payloads use the short name. */
function isEntryType(value: unknown, name: string): boolean {
  return typeof value === "string" && (value === name || value === `ENTRY_TYPE_${name}`);
}

function computerUsePayload(frame: unknown):
  | {
      error?: unknown;
      screenshot?: unknown;
      cursorPosition?: unknown;
    }
  | undefined {
  const client = asRecord(asRecord(frame).execClientMessage);
  const result = asRecord(client.computerUseResult);
  const error = asRecord(result.error);
  const success = asRecord(result.success);
  if (Object.keys(error).length === 0 && Object.keys(success).length === 0) return undefined;
  return {
    error: error.error,
    screenshot: success.screenshot,
    cursorPosition: success.cursorPosition,
  };
}

function isCoordinate(value: unknown): value is { x: number; y: number } {
  const record = asRecord(value);
  return typeof record.x === "number" && typeof record.y === "number";
}

function nestedString(record: Record<string, unknown>, key: string, field: string): string {
  const nested = asRecord(record[key]);
  return typeof nested[field] === "string" ? nested[field] : "";
}

function nestedNumber(
  record: Record<string, unknown>,
  key: string,
  field: string,
): number | undefined {
  return numberValue(asRecord(record[key])[field]);
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function isPng(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 24 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  );
}

function isWebp(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  );
}

function webpSize(bytes: Uint8Array): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let canvas: { width: number; height: number } | undefined;
  let keyframe: { width: number; height: number } | undefined;
  let offset = 12;
  while (offset + 8 <= bytes.byteLength) {
    const fourcc = String.fromCharCode(
      bytes[offset] ?? 0,
      bytes[offset + 1] ?? 0,
      bytes[offset + 2] ?? 0,
      bytes[offset + 3] ?? 0,
    );
    const size = view.getUint32(offset + 4, true);
    const payload = offset + 8;
    if (size > bytes.byteLength || payload + size > bytes.byteLength) break;
    if (fourcc === "VP8X" && size >= 10) {
      const width = vp8xDimension(bytes, payload + 4);
      const height = vp8xDimension(bytes, payload + 7);
      if (width > 0 && height > 0) canvas = { width, height };
    } else if (fourcc === "VP8 " && size >= 10 && ((bytes[payload] ?? 1) & 1) === 0) {
      const start =
        bytes[payload + 3] === 0x9d && bytes[payload + 4] === 0x01 && bytes[payload + 5] === 0x2a;
      if (start) {
        const width = ((bytes[payload + 6] ?? 0) | ((bytes[payload + 7] ?? 0) << 8)) & 0x3fff;
        const height = ((bytes[payload + 8] ?? 0) | ((bytes[payload + 9] ?? 0) << 8)) & 0x3fff;
        if (width > 0 && height > 0) keyframe = { width, height };
      }
    }
    offset = payload + size + (size & 1);
  }
  return canvas ?? keyframe ?? { width: 0, height: 0 };
}

function vp8xDimension(bytes: Uint8Array, offset: number): number {
  return (
    1 + (bytes[offset] ?? 0) + ((bytes[offset + 1] ?? 0) << 8) + ((bytes[offset + 2] ?? 0) << 16)
  );
}

function jpegSize(bytes: Uint8Array): { width: number; height: number } {
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) break;
    const marker = bytes[offset + 1] ?? 0;
    const length = ((bytes[offset + 2] ?? 0) << 8) + (bytes[offset + 3] ?? 0);
    if (marker >= 0xc0 && marker <= 0xc3) {
      return {
        height: ((bytes[offset + 5] ?? 0) << 8) + (bytes[offset + 6] ?? 0),
        width: ((bytes[offset + 7] ?? 0) << 8) + (bytes[offset + 8] ?? 0),
      };
    }
    if (length < 2) break;
    offset += 2 + length;
  }
  return { width: 0, height: 0 };
}
