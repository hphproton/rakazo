import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AdapterContext, ProcessEvent, SandboxProvider } from "@rakazo/adapter-kit";
import { openScreenCapability, sealScreenCapability } from "@rakazo/core/node/screen-capability";
import { describe, expect, it, vi } from "vitest";
import { resolveBotWorkspacePath } from "./computer-support.js";
import { checkpointRunningComputer } from "./computer-workspace.js";
import { LocalAgentHomeStore } from "./home.js";
import { SAND_HAND_REFUSAL } from "./sand-hand.js";
import type {
  SandComputerAction,
  SandDirectoryEntry,
  SandExecRequest,
  SandHost,
} from "./sand-host.js";
import {
  ConnectSandHost,
  isDirectoryReadError,
  SAND_AGENT_HEADER,
  SAND_DISPLAY_HEADER,
  SAND_WINDOW_OWNER_HEADER,
  SandHostError,
  SandPathIsDirectoryError,
  sandHostBaseUrl,
  sandImageMeta,
} from "./sand-host.js";
import { SAND_WORKSPACE, SandSandboxProvider, sandWorkspacePath } from "./sand-sandbox.js";
import type { SandSeatPolicy, SandSeatRequest } from "./sand-seat.js";
import {
  MappedSandSeatPolicy,
  RefusingSandSeatPolicy,
  SandDisplayForbiddenError,
  SandSeatInvalidError,
  SandSeatUnmappedError,
  sandScreenSelectsForbiddenDisplay,
} from "./sand-seat.js";
import type { TeamDesktopHost, TeamDesktopRecord, TeamDesktopStore } from "./team-desktop.js";
import {
  createTeamDesktopAllocator,
  TeamDesktopExhaustedError,
  TeamDesktopMissingError,
  teamDesktopViewerUrl,
} from "./team-desktop.js";

const AGENT_A = "11111111-1111-4111-8111-111111111111";
const AGENT_B = "22222222-2222-4222-8222-222222222222";
const PNG = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  ),
);

const ctx: AdapterContext = {
  operationId: "1",
  traceId: "1",
  spaceId: "w",
  userId: "u",
  signal: new AbortController().signal,
};

/** Test double for a future seat policy. Not a product borrow map. */
class FixedSeatPolicy implements SandSeatPolicy {
  constructor(private readonly seats: Record<string, string>) {}

  resolve(request: SandSeatRequest) {
    const agentId = this.seats[request.botId];
    return agentId ? { agentId } : undefined;
  }
}

class RecordingHost implements SandHost {
  readonly calls: Array<{ method: string; agentId: string; body?: unknown }> = [];
  files = new Map<string, Uint8Array>();
  screenshot: Uint8Array = PNG;
  screen: string | null = null;

  async capabilities(agentId: string) {
    this.calls.push({ method: "capabilities", agentId });
    return { computerUseSupported: true };
  }

  async *exec(
    agentId: string,
    request: SandExecRequest,
    _signal: AbortSignal,
  ): AsyncIterable<ProcessEvent> {
    this.calls.push({ method: "exec", agentId, body: request });
    yield { type: "stdout", data: "ok\n" };
    yield { type: "exit", code: 0 };
  }

  async listDirectory(agentId: string, path: string): Promise<SandDirectoryEntry[]> {
    this.calls.push({ method: "listDirectory", agentId, body: path });
    if (path === SAND_WORKSPACE) {
      return [{ name: "notes", path: `${SAND_WORKSPACE}/notes`, type: "DIRECTORY", sizeBytes: 0 }];
    }
    if (path === `${SAND_WORKSPACE}/notes`) {
      return [
        {
          name: "result.txt",
          path: `${SAND_WORKSPACE}/notes/result.txt`,
          type: "FILE",
          sizeBytes: this.files.get(`${SAND_WORKSPACE}/notes/result.txt`)?.byteLength ?? 8,
        },
      ];
    }
    return [];
  }

  async readFile(agentId: string, path: string) {
    this.calls.push({ method: "readFile", agentId, body: path });
    return this.files.get(path) ?? new TextEncoder().encode("portable");
  }

  async writeFile(agentId: string, path: string, content: Uint8Array) {
    this.calls.push({ method: "writeFile", agentId, body: { path, content } });
    this.files.set(path, content);
  }

  async computerUse(agentId: string, actions: readonly SandComputerAction[]) {
    this.calls.push({ method: "computerUse", agentId, body: actions });
    return { screenshot: this.screenshot, cursor: { x: 3, y: 4 } };
  }

  screenUrl(agentId: string) {
    this.calls.push({ method: "screenUrl", agentId });
    return this.screen;
  }
}

function provider(host: SandHost, seats: Record<string, string> = { "bot-a": AGENT_A }) {
  return new SandSandboxProvider({ policy: new FixedSeatPolicy(seats), host });
}

describe("sand seat policy", () => {
  it("refuses a Rakazo bot id, including one that is already a UUID", async () => {
    const host = new RecordingHost();
    const sandbox = new SandSandboxProvider({ policy: new RefusingSandSeatPolicy(), host });
    await expect(
      sandbox.provision({ botId: "bot-a", homePath: "/home/rakazo" }, ctx),
    ).rejects.toThrow(SandSeatUnmappedError);
    await expect(
      sandbox.provision({ botId: AGENT_A, homePath: "/home/rakazo", providerRef: AGENT_A }, ctx),
    ).rejects.toThrow(/no seat policy/i);
    expect(host.calls).toEqual([]);
  });

  it("rejects a policy that echoes the bot id or returns a non-agent", async () => {
    const host = new RecordingHost();
    const echoed = new SandSandboxProvider({
      policy: { resolve: (request) => ({ agentId: request.botId }) },
      host,
    });
    await expect(echoed.provision({ botId: AGENT_A, homePath: "/tmp" }, ctx)).rejects.toThrow(
      SandSeatInvalidError,
    );
    const invented = new SandSandboxProvider({
      policy: { resolve: () => ({ agentId: "createAgent" }) },
      host,
    });
    await expect(invented.provision({ botId: "bot-a", homePath: "/tmp" }, ctx)).rejects.toThrow(
      /not a sand agent UUID/,
    );
    const display = new SandSandboxProvider({
      policy: { resolve: () => ({ agentId: ":1" }) },
      host,
    });
    await expect(display.provision({ botId: "bot-a", homePath: "/tmp" }, ctx)).rejects.toThrow(
      SandDisplayForbiddenError,
    );
    expect(host.calls).toEqual([]);
  });

  it("does not treat a stored provider ref as a seat when the policy disagrees", async () => {
    const host = new RecordingHost();
    const sandbox = provider(host);
    await expect(
      sandbox.provision({ botId: "bot-a", homePath: "/tmp", providerRef: AGENT_B }, ctx),
    ).rejects.toThrow(SandSeatUnmappedError);
    expect(host.calls).toEqual([]);
  });
});

describe("sand sandbox provider", () => {
  it("attaches an existing agent without creating one", async () => {
    const host = new RecordingHost();
    const sandbox = provider(host);
    expect(sandbox.describe()).toMatchObject({
      id: "sand",
      capabilities: {
        graphical: true,
        multiScreen: false,
        pty: false,
        snapshots: false,
        takeover: false,
      },
    });
    const described: SandboxProvider = sandbox;
    expect(described.pageBrowser).toBeUndefined();
    const computer = await sandbox.provision({ botId: "bot-a", homePath: "/home/rakazo" }, ctx);
    expect(computer).toMatchObject({
      id: `sand:${AGENT_A}`,
      botId: "bot-a",
      kind: "sand",
      providerRef: AGENT_A,
      fresh: false,
    });
    await sandbox.prepare(computer, ctx);
    expect(host.calls.map((call) => call.method)).toEqual(["capabilities"]);
    const before = host.calls.length;
    await sandbox.stop(computer, ctx);
    await sandbox.destroy(computer, ctx);
    expect(host.calls).toHaveLength(before);
  });

  it("runs shell on that agent workspace and strips display env", async () => {
    const host = new RecordingHost();
    const sandbox = provider(host, { "bot-a": AGENT_A, "bot-b": AGENT_B });
    const first = await sandbox.provision({ botId: "bot-a", homePath: "/unused" }, ctx);
    const second = await sandbox.provision({ botId: "bot-b", homePath: "/unused" }, ctx);
    let stdout = "";
    for await (const event of sandbox.execute(
      first,
      { argv: ["echo", "graphical-ok"], env: { DISPLAY: ":1", FOO: "bar" } },
      ctx,
    )) {
      if (event.type === "stdout") stdout += event.data;
      if (event.type === "exit") expect(event.code).toBe(0);
    }
    expect(stdout).toContain("ok");
    expect(host.calls.at(-1)).toMatchObject({
      method: "exec",
      agentId: AGENT_A,
      body: {
        argv: ["echo", "graphical-ok"],
        cwd: SAND_WORKSPACE,
        env: { FOO: "bar" },
      },
    });
    for await (const event of sandbox.execute(second, { argv: ["pwd"], cwd: "notes" }, ctx)) {
      if (event.type === "exit") expect(event.code).toBe(0);
    }
    expect(host.calls.at(-1)).toMatchObject({
      agentId: AGENT_B,
      body: { cwd: `${SAND_WORKSPACE}/notes` },
    });
    await expect(async () => {
      for await (const _event of sandbox.execute(first, { argv: ["ls"], cwd: "/etc" }, ctx)) {
        // drain
      }
    }).rejects.toThrow(/outside the sand workspace/);
  });

  it("times out a command that ignores the abort signal's deadline", async () => {
    const host = new RecordingHost();
    host.exec = async function* (
      _agentId: string,
      _request: SandExecRequest,
      signal: AbortSignal,
    ): AsyncIterable<ProcessEvent> {
      if (signal.aborted) {
        throw signal.reason instanceof Error ? signal.reason : new Error("aborted");
      }
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 5_000);
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
        });
      });
    };
    const sandbox = provider(host);
    const computer = await sandbox.provision({ botId: "bot-a", homePath: "/tmp" }, ctx);
    const events: ProcessEvent[] = [];
    const started = Date.now();
    for await (const event of sandbox.execute(
      computer,
      { argv: ["sleep", "10"], timeoutMs: 40 },
      ctx,
    )) {
      events.push(event);
    }
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(events).toContainEqual({ type: "exit", code: 124 });
  });

  it("round-trips files on the shared workspace", async () => {
    const host = new RecordingHost();
    const sandbox = provider(host);
    const computer = await sandbox.provision({ botId: "bot-a", homePath: "/home/rakazo" }, ctx);
    await sandbox.writeFile(
      computer,
      { path: "notes/result.txt", content: new TextEncoder().encode("portable"), executable: true },
      ctx,
    );
    expect(host.files.get(`${SAND_WORKSPACE}/notes/result.txt`)).toEqual(
      new TextEncoder().encode("portable"),
    );
    expect(host.calls.filter((call) => call.method === "exec").at(-1)?.body).toMatchObject({
      argv: ["chmod", "+x", `${SAND_WORKSPACE}/notes/result.txt`],
    });
    expect(await sandbox.listFiles(computer, "notes", ctx)).toEqual([
      { path: "notes/result.txt", kind: "file", size: 8 },
    ]);
    expect(host.calls.some((call) => call.method === "exec" && lsArgv(call.body))).toBe(false);
    expect(
      new TextDecoder().decode(await sandbox.readFile(computer, "notes/result.txt", ctx)),
    ).toBe("portable");
    const exported = [];
    for await (const file of sandbox.exportWorkspace(computer, ctx)) exported.push(file);
    expect(exported.map((file) => file.path)).toContain("notes/result.txt");
  });

  it("lists a readable directory through ls when ListDirectory returns 403", async () => {
    const host = new RecordingHost();
    const notes = `${SAND_WORKSPACE}/notes`;
    host.files.set(`${notes}/result.txt`, new TextEncoder().encode("portable"));
    host.files.set(`${SAND_WORKSPACE}/readme.txt`, new TextEncoder().encode("hi"));
    host.listDirectory = async (agentId, path) => {
      host.calls.push({ method: "listDirectory", agentId, body: path });
      throw new SandHostError("ControlService", "ListDirectory", 403);
    };
    host.exec = async function* (agentId, request) {
      host.calls.push({ method: "exec", agentId, body: request });
      const target = request.argv.at(-1);
      if (target === SAND_WORKSPACE) {
        yield { type: "stdout", data: "notes/\nsecret@\nreadme.txt\n" };
        yield { type: "exit", code: 0 };
        return;
      }
      if (target === notes) {
        yield { type: "stdout", data: "result.txt\n" };
        yield { type: "exit", code: 0 };
        return;
      }
      yield { type: "stderr", data: "ls: cannot open directory: Permission denied\n" };
      yield { type: "exit", code: 2 };
    };
    const sandbox = provider(host);
    const computer = await sandbox.provision({ botId: "bot-a", homePath: "/tmp" }, ctx);
    await expect(sandbox.listFiles(computer, SAND_WORKSPACE, ctx)).resolves.toEqual([
      { path: "notes", kind: "dir", size: 0 },
      { path: "readme.txt", kind: "file", size: 0 },
    ]);
    const exported = [];
    for await (const file of sandbox.exportWorkspace(computer, ctx)) exported.push(file.path);
    expect(exported).toEqual(["notes/result.txt", "readme.txt"]);
    expect(
      host.calls.filter((call) => call.method === "readFile").map((call) => call.body),
    ).toEqual([`${notes}/result.txt`, `${SAND_WORKSPACE}/readme.txt`]);
  });

  it("keeps ListDirectory 403 when ls cannot open the directory", async () => {
    const host = new RecordingHost();
    host.listDirectory = async (agentId, path) => {
      host.calls.push({ method: "listDirectory", agentId, body: path });
      throw new SandHostError("ControlService", "ListDirectory", 403);
    };
    host.exec = async function* (agentId, request) {
      host.calls.push({ method: "exec", agentId, body: request });
      yield { type: "stderr", data: "ls: cannot open directory: Permission denied\n" };
      yield { type: "exit", code: 2 };
    };
    const sandbox = provider(host);
    const computer = await sandbox.provision({ botId: "bot-a", homePath: "/tmp" }, ctx);
    await expect(sandbox.listFiles(computer, "shared", ctx)).rejects.toThrow(
      "sand ControlService/ListDirectory failed: 403",
    );
    await expect(async () => {
      for await (const _file of sandbox.exportWorkspace(computer, ctx)) {
        // A denied root listing throws before the first file.
      }
    }).rejects.toThrow("sand ControlService/ListDirectory failed: 403");
  });

  it("does not shell out when ListDirectory fails for another status", async () => {
    const host = new RecordingHost();
    host.listDirectory = async (agentId, path) => {
      host.calls.push({ method: "listDirectory", agentId, body: path });
      throw new SandHostError("ControlService", "ListDirectory", 404);
    };
    const sandbox = provider(host);
    const computer = await sandbox.provision({ botId: "bot-a", homePath: "/tmp" }, ctx);
    await expect(sandbox.listFiles(computer, "missing", ctx)).rejects.toThrow(/404/);
    expect(host.calls.some((call) => call.method === "exec")).toBe(false);
  });

  it("lists a directory instead of calling ReadBinaryFile", async () => {
    const host = new RecordingHost();
    const agentTools = `${SAND_WORKSPACE}/agent-tools`;
    const page = `${agentTools}/page.txt`;
    host.files.set(page, new TextEncoder().encode("page"));
    host.listDirectory = async (agentId, path) => {
      host.calls.push({ method: "listDirectory", agentId, body: path });
      if (path === SAND_WORKSPACE) {
        return [
          { name: "notes", path: `${SAND_WORKSPACE}/notes`, type: "DIRECTORY", sizeBytes: 0 },
          { name: "agent-tools", path: agentTools, type: "DIRECTORY", sizeBytes: 0 },
        ];
      }
      if (path === agentTools) {
        return [{ name: "page.txt", path: page, type: "FILE", sizeBytes: 4 }];
      }
      if (path === `${SAND_WORKSPACE}/notes`) {
        return [
          {
            name: "result.txt",
            path: `${SAND_WORKSPACE}/notes/result.txt`,
            type: "FILE",
            sizeBytes: 8,
          },
        ];
      }
      return [];
    };
    const sandbox = provider(host);
    const computer = await sandbox.provision({ botId: "bot-a", homePath: "/tmp" }, ctx);
    await expect(sandbox.readFile(computer, "agent-tools", ctx)).rejects.toThrow(
      SandPathIsDirectoryError,
    );
    await expect(sandbox.readFile(computer, SAND_WORKSPACE, ctx)).rejects.toThrow(
      "path is a directory",
    );
    expect(
      host.calls.some(
        (call) =>
          call.method === "readFile" && (call.body === agentTools || call.body === SAND_WORKSPACE),
      ),
    ).toBe(false);
    expect(new TextDecoder().decode(await sandbox.readFile(computer, page, ctx))).toBe("page");
    const exported = [];
    for await (const file of sandbox.exportWorkspace(computer, ctx)) exported.push(file.path);
    expect(exported).toContain("agent-tools/page.txt");
    expect(exported).not.toContain("agent-tools");
    expect(isDirectoryReadError(new SandPathIsDirectoryError())).toBe(true);
    expect(isDirectoryReadError(new Error("Path is a directory EISDIR"))).toBe(true);
    expect(isDirectoryReadError(new Error("file exceeds maxBytes"))).toBe(false);
  });

  it("observes and acts through computer use for that agent", async () => {
    const host = new RecordingHost();
    const sandbox = provider(host);
    const computer = await sandbox.provision({ botId: "bot-a", homePath: "/tmp" }, ctx);
    const observed = await sandbox.observe(computer, ctx);
    expect(observed.image.byteLength).toBeGreaterThan(0);
    expect(observed).toMatchObject({
      mimeType: "image/png",
      width: 1,
      height: 1,
      cursor: { x: 3, y: 4 },
    });
    expect(host.calls.at(-1)?.body).toEqual([{ screenshot: {} }]);
    const acted = await sandbox.act(
      computer,
      {
        actions: [
          { kind: "pointer", type: "click", x: 8, y: 9, button: "left" },
          { kind: "clipboard", text: "typed" },
        ],
        observe: true,
      },
      ctx,
    );
    expect(acted.completed).toBe(2);
    expect(acted.observation?.image.byteLength).toBeGreaterThan(0);
    expect(host.calls.at(-1)?.body).toEqual([
      { click: { coordinate: { x: 8, y: 9 }, button: "LEFT", count: 1 } },
      { type: { text: "typed" } },
      { screenshot: {} },
    ]);
    await expect(
      sandbox.act(computer, { actions: [{ kind: "focus", application: "xterm" }] }, ctx),
    ).rejects.toThrow(SAND_HAND_REFUSAL);
    await expect(
      sandbox.act(computer, { actions: [{ kind: "open", path: "notes/result.txt" }] }, ctx),
    ).rejects.toThrow(SAND_HAND_REFUSAL);
    await expect(
      sandbox.act(computer, { actions: [{ kind: "launch", application: "xterm" }] }, ctx),
    ).rejects.toThrow(SAND_HAND_REFUSAL);
  });

  it("returns a reported screen url and refuses display :1 and :3", async () => {
    const host = new RecordingHost();
    host.screen = "http://127.0.0.1:1339/agents/11111111-1111-4111-8111-111111111111/vnc";
    const sandbox = provider(host);
    const computer = await sandbox.provision({ botId: "bot-a", homePath: "/tmp" }, ctx);
    expect((await sandbox.connectScreen(computer, { view: "stream" }, ctx)).url).toBe(host.screen);
    host.screen = "http://127.0.0.1:6080/vnc.html?display=:1";
    await expect(sandbox.connectScreen(computer, { view: "stream" }, ctx)).rejects.toThrow(
      SandDisplayForbiddenError,
    );
    host.screen = "http://127.0.0.1:6080/vnc.html?display=:3";
    await expect(sandbox.connectScreen(computer, { view: "snapshot" }, ctx)).rejects.toThrow(
      /display :1 or :3/,
    );
  });
});

describe("sand host router", () => {
  it("does not treat the router port as display :1", () => {
    expect(sandScreenSelectsForbiddenDisplay("http://127.0.0.1:1339")).toBe(false);
    expect(sandScreenSelectsForbiddenDisplay("display=:1")).toBe(true);
    expect(sandScreenSelectsForbiddenDisplay("DISPLAY=:3")).toBe(true);
    expect(sandHostBaseUrl(undefined)).toBe("http://127.0.0.1:1339");
    expect(sandWorkspacePath(undefined)).toBe(SAND_WORKSPACE);
    expect(sandWorkspacePath("notes")).toBe(`${SAND_WORKSPACE}/notes`);
  });

  it("speaks ControlService and ExecService for one agent id", async () => {
    const urls: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      urls.push(url);
      const headers = new Headers(init?.headers);
      expect(headers.get(SAND_AGENT_HEADER)).toBe(AGENT_A);
      expect(headers.get("authorization")).toBe("Bearer test-sand-token");
      if (url.endsWith("/agent.v1.ControlService/GetCapabilities")) {
        return Response.json({ computerUseSupported: true });
      }
      if (url.endsWith("/agent.v1.ControlService/Exec")) {
        const body = framedJson(init?.body);
        expect(body).toMatchObject({ command: "echo", args: ["hi"], cwd: SAND_WORKSPACE });
        expect(body).not.toHaveProperty("environment");
        return new Response(
          Buffer.concat([
            frame(0, { stdoutEvent: { data: "hi\n" } }),
            frame(0, { exitEvent: { exitCode: 0 } }),
            frame(2, {}),
          ]),
        );
      }
      if (url.endsWith("/agent.v1.ExecService/Exec")) {
        const body = framedJson(init?.body);
        expect(body).toMatchObject({
          computerUseArgs: { desktopLeaseActorId: AGENT_A, actions: [{ screenshot: {} }] },
        });
        return new Response(
          Buffer.concat([
            frame(0, {
              execClientMessage: {
                computerUseResult: {
                  success: { screenshot: Buffer.from(PNG).toString("base64"), actionCount: 1 },
                },
              },
            }),
            frame(2, {}),
          ]),
        );
      }
      if (url.endsWith("/agent.v1.ControlService/ListDirectory")) {
        return Response.json({
          entries: [{ name: "a.txt", path: `${SAND_WORKSPACE}/a.txt`, type: "FILE", sizeBytes: 1 }],
        });
      }
      return new Response("no", { status: 404 });
    });
    const host = new ConnectSandHost({
      baseUrl: "http://127.0.0.1:1339",
      token: "test-sand-token",
      fetch: fetchMock,
    });
    expect(host.screenUrl(AGENT_A)).toBeNull();
    await expect(host.capabilities(AGENT_A, ctx.signal)).resolves.toEqual({
      computerUseSupported: true,
    });
    const events: ProcessEvent[] = [];
    for await (const event of host.exec(
      AGENT_A,
      { argv: ["echo", "hi"], cwd: SAND_WORKSPACE, env: { DISPLAY: ":1" }, timeoutMs: 1_000 },
      ctx.signal,
    )) {
      events.push(event);
    }
    expect(events).toEqual([
      { type: "stdout", data: "hi\n" },
      { type: "exit", code: 0 },
    ]);
    const shot = await host.computerUse(AGENT_A, [{ screenshot: {} }], ctx.signal);
    expect(sandImageMeta(shot.screenshot ?? new Uint8Array())).toMatchObject({
      mimeType: "image/png",
      width: 1,
      height: 1,
    });
    await expect(host.listDirectory(AGENT_A, SAND_WORKSPACE, ctx.signal)).resolves.toEqual([
      { name: "a.txt", path: `${SAND_WORKSPACE}/a.txt`, type: "FILE", sizeBytes: 1 },
    ]);
    expect(
      urls.some((url) => url.includes("createAgent") || url.includes("ensureForeverBox")),
    ).toBe(false);
    expect(urls.some((url) => url.includes(":1/") || url.includes("display=:1"))).toBe(false);
  });

  it("turns a directory ReadBinaryFile into a directory error", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/agent.v1.ControlService/ReadBinaryFile")) {
        return Response.json(
          { code: "invalid_argument", message: "Path is a directory", node: "EISDIR" },
          { status: 400 },
        );
      }
      if (url.endsWith("/agent.v1.ControlService/ListDirectory")) {
        return Response.json({ entries: [] });
      }
      return new Response("missing", { status: 404 });
    });
    const host = new ConnectSandHost({ fetch: fetchMock });
    const sandbox = provider(host);
    const computer = await sandbox.provision({ botId: "bot-a", homePath: "/tmp" }, ctx);
    await expect(
      host.readFile(AGENT_A, `${SAND_WORKSPACE}/agent-tools`, ctx.signal),
    ).rejects.toThrow("path is a directory");
    await expect(sandbox.readFile(computer, "agent-tools", ctx)).rejects.toThrow(
      SandPathIsDirectoryError,
    );
    const other = new ConnectSandHost({
      fetch: vi.fn(async () => Response.json({ message: "no such file" }, { status: 400 })),
    });
    await expect(
      other.readFile(AGENT_A, `${SAND_WORKSPACE}/missing.txt`, ctx.signal),
    ).rejects.toThrow(SandHostError);
  });

  it("keeps a Team /workspace path and maps ENTRY_TYPE_DIRECTORY without ReadBinaryFile", async () => {
    const reads: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(new TextDecoder().decode(init?.body as Uint8Array)) as {
        path?: string;
      };
      if (url.endsWith("/agent.v1.ControlService/ListDirectory")) {
        if (body.path === SAND_WORKSPACE) {
          return Response.json({
            entries: [
              {
                name: "agent-tools",
                path: `${SAND_WORKSPACE}/agent-tools`,
                type: "ENTRY_TYPE_DIRECTORY",
                sizeBytes: 0,
              },
            ],
          });
        }
        if (body.path === `${SAND_WORKSPACE}/agent-tools`) {
          return Response.json({
            entries: [
              {
                name: "page.txt",
                path: `${SAND_WORKSPACE}/agent-tools/page.txt`,
                type: "ENTRY_TYPE_FILE",
                sizeBytes: 4,
              },
            ],
          });
        }
        return Response.json({ entries: [] });
      }
      if (url.endsWith("/agent.v1.ControlService/ReadBinaryFile")) {
        reads.push(body.path ?? "");
        return Response.json({ content: Buffer.from("page").toString("base64") });
      }
      return new Response("missing", { status: 404 });
    });
    const sandbox = provider(new ConnectSandHost({ fetch: fetchMock }));
    const computer = await sandbox.provision({ botId: "bot-a", homePath: "/tmp" }, ctx);
    const stored = resolveBotWorkspacePath("team", "bot-a", "/workspace/agent-tools");
    expect(sandWorkspacePath(stored)).toBe(`${SAND_WORKSPACE}/agent-tools`);
    await expect(sandbox.readFile(computer, stored, ctx)).rejects.toThrow(SandPathIsDirectoryError);
    expect(reads).toEqual([]);
    await expect(sandbox.listFiles(computer, stored, ctx)).resolves.toEqual([
      { path: "agent-tools/page.txt", kind: "file", size: 4 },
    ]);
  });

  it("treats a listable ReadBinaryFile 400 as a directory", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(new TextDecoder().decode(init?.body as Uint8Array)) as {
        path?: string;
      };
      if (url.endsWith("/agent.v1.ControlService/ListDirectory")) {
        if (body.path === `${SAND_WORKSPACE}/agent-tools`) {
          return Response.json({
            entries: [
              {
                name: "page.txt",
                path: `${SAND_WORKSPACE}/agent-tools/page.txt`,
                type: "ENTRY_TYPE_FILE",
                sizeBytes: 1,
              },
            ],
          });
        }
        return new Response("missing", { status: 404 });
      }
      if (url.endsWith("/agent.v1.ControlService/ReadBinaryFile")) {
        return Response.json({ code: "invalid_argument" }, { status: 400 });
      }
      return new Response("missing", { status: 404 });
    });
    const sandbox = provider(new ConnectSandHost({ fetch: fetchMock }));
    const computer = await sandbox.provision({ botId: "bot-a", homePath: "/tmp" }, ctx);
    await expect(sandbox.readFile(computer, "agent-tools", ctx)).rejects.toThrow(
      SandPathIsDirectoryError,
    );
    const missing = provider(
      new ConnectSandHost({
        fetch: vi.fn(async (input: string | URL | Request) => {
          const url = String(input);
          if (url.endsWith("/ListDirectory")) return new Response("missing", { status: 404 });
          return Response.json({ message: "no such file" }, { status: 400 });
        }),
      }),
    );
    const other = await missing.provision({ botId: "bot-a", homePath: "/tmp" }, ctx);
    await expect(missing.readFile(other, "missing.txt", ctx)).rejects.toThrow(SandHostError);
  });

  it("hides the router token when the request fails", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("connect failed for test-sand-token");
    });
    const host = new ConnectSandHost({ token: "test-sand-token", fetch: fetchMock });
    await expect(host.capabilities(AGENT_A, ctx.signal)).rejects.toThrow(
      "sand host request failed",
    );
  });

  it("sends a Team desktop through the router and leaves a bot without a row on the seat map", async () => {
    const urls: string[] = [];
    const seen: Array<Record<string, string | null>> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      urls.push(url);
      const headers = new Headers(init?.headers);
      seen.push({
        display: headers.get(SAND_DISPLAY_HEADER),
        owner: headers.get(SAND_WINDOW_OWNER_HEADER),
        agent: headers.get(SAND_AGENT_HEADER),
        authorization: headers.get("authorization"),
      });
      if (url.endsWith("/agent.v1.ControlService/Exec")) {
        return new Response(
          Buffer.concat([
            frame(0, { stdoutEvent: { data: "ok\n" } }),
            frame(0, { exitEvent: { exitCode: 0 } }),
            frame(2, {}),
          ]),
        );
      }
      return new Response("no", { status: 404 });
    });
    const ownerToken = "fixture-owner-token";
    let ensured = 0;
    const sandbox = new SandSandboxProvider({
      policy: new FixedSeatPolicy({ "bot-a": AGENT_A, "bot-b": AGENT_B }),
      host: new ConnectSandHost({
        baseUrl: "http://127.0.0.1:14020",
        token: "test-sand-token",
        fetch: fetchMock,
      }),
      teamDesktops: {
        async resolve(botId) {
          if (botId !== "bot-a") return undefined;
          return { displayIndex: 121, ownerToken };
        },
        async ensure(botId) {
          ensured += 1;
          if (botId !== "bot-a") throw new TeamDesktopMissingError(botId);
          return { displayIndex: 121, ownerToken };
        },
      },
    });
    const team = await sandbox.provision({ botId: "bot-a", homePath: "/tmp" }, ctx);
    expect(team.providerRef).toBe(AGENT_A);
    expect(ensured).toBe(0);
    const teamContext = { ...ctx, botId: "bot-a" };
    for await (const event of sandbox.execute(
      team,
      { argv: ["echo", "desk"], cwd: SAND_WORKSPACE },
      teamContext,
    )) {
      if (event.type === "exit") expect(event.code).toBe(0);
    }
    expect(ensured).toBe(1);
    expect(urls[0]).toBe("http://127.0.0.1:1339/agent.v1.ControlService/Exec");
    expect(urls.some((url) => url.includes("14020"))).toBe(false);
    expect(seen[0]).toEqual({
      display: "121",
      owner: ownerToken,
      agent: null,
      authorization: "Bearer test-sand-token",
    });
    expect((await sandbox.connectScreen(team, { view: "stream" }, teamContext)).url).toBe(
      "http://127.0.0.1:6081?token=121",
    );
    expect(ensured).toBe(1);

    const seat = await sandbox.provision({ botId: "bot-b", homePath: "/tmp" }, ctx);
    expect(seat.providerRef).toBe(AGENT_B);
    for await (const event of sandbox.execute(
      seat,
      { argv: ["echo", "seat"], cwd: SAND_WORKSPACE },
      { ...ctx, botId: "bot-b" },
    )) {
      if (event.type === "exit") expect(event.code).toBe(0);
    }
    expect(ensured).toBe(2);
    expect(urls.at(-1)).toBe("http://127.0.0.1:14020/agent.v1.ControlService/Exec");
    expect(seen.at(-1)).toEqual({
      display: null,
      owner: null,
      agent: AGENT_B,
      authorization: "Bearer test-sand-token",
    });
  });

  it("returns desktop exhaustion as shell output for that call", async () => {
    const sandbox = new SandSandboxProvider({
      policy: new FixedSeatPolicy({ "bot-a": AGENT_A }),
      host: new ConnectSandHost({ baseUrl: "http://127.0.0.1:14020", fetch: vi.fn() }),
      teamDesktops: {
        async resolve() {
          return undefined;
        },
        async ensure() {
          throw new TeamDesktopExhaustedError();
        },
      },
    });
    const computer = await sandbox.provision({ botId: "bot-a", homePath: "/tmp" }, ctx);
    const events: ProcessEvent[] = [];
    for await (const event of sandbox.execute(
      computer,
      { argv: ["echo", "desk"], cwd: SAND_WORKSPACE },
      { ...ctx, botId: "bot-a" },
    )) {
      events.push(event);
    }
    expect(events).toContainEqual({
      type: "stderr",
      data: "No free Team desktop in 101-150.\n",
    });
    expect(events).toContainEqual({ type: "exit", code: 1 });
  });

  it("seals the in-app viewer onto that bot's 6081 display token", () => {
    const upstream = teamDesktopViewerUrl(121);
    expect(upstream).toBe("http://127.0.0.1:6081?token=121");
    const sealed = sealScreenCapability(
      upstream,
      "fake-secret",
      "https://app.example",
      {
        botId: "bot-a",
        computerId: "computer",
        botGeneration: 1,
        computerGeneration: 1,
        controlLeaseId: null,
      },
      100,
    );
    const page = new URL(sealed);
    expect(page.origin).toBe("https://app.example");
    expect(page.pathname.startsWith("/novnc/session/view/")).toBe(true);
    expect(page.search).not.toContain("token=121");
    expect(sealed).not.toContain("14020");
    expect(sealed).not.toContain(":20");
    const socketPath = new URL(page.searchParams.get("path") ?? "", page.origin).pathname;
    expect(openScreenCapability(socketPath, "fake-secret", 101)?.target).toMatchObject({
      protocol: "http:",
      hostname: "127.0.0.1",
      port: 6081,
      path: "/websockify?token=121",
    });
  });

  it("runs a team member that has no seat-map entry", async () => {
    const desk = teamMemberDesk(["deputy"], new Map([["chief", AGENT_A]]));
    const context = { ...ctx, botId: "deputy" };
    const computer = await desk.sandbox.provision(
      { botId: "team-space", homePath: "/tmp" },
      context,
    );
    expect(computer.providerRef).toBe("team-desktop");
    expect(desk.urls).toEqual([]);
    expect((await desk.sandbox.connectScreen(computer, { view: "stream" }, context)).url).toBe(
      "http://127.0.0.1:6081?token=101",
    );
    expect(desk.urls).toEqual([]);
    await prepareAndExec(desk.sandbox, computer, "deputy");
    expect(desk.urls[0]).toBe("http://127.0.0.1:1339/agent.v1.ControlService/GetCapabilities");
    expect(desk.urls.every((url) => url.startsWith("http://127.0.0.1:1339/"))).toBe(true);
    expect(desk.urls.some((url) => url.includes("14020"))).toBe(false);
    expect(desk.seen.every((call) => call.display === "101" && call.agent === null)).toBe(true);
    expect(desk.seen.every((call) => call.ownerLength > 16)).toBe(true);
    expect(desk.store.rows.get("deputy")?.displayIndex).toBe(101);
    expect((await desk.sandbox.connectScreen(computer, { view: "stream" }, context)).url).toBe(
      "http://127.0.0.1:6081?token=101",
    );
  });

  it("does not call the seat host for a team member that is also in the seat map", async () => {
    const desk = teamMemberDesk(
      ["chief"],
      new Map([
        ["chief", AGENT_A],
        ["team-space", AGENT_A],
      ]),
    );
    const context = { ...ctx, botId: "chief" };
    const computer = await desk.sandbox.provision(
      { botId: "team-space", homePath: "/tmp" },
      context,
    );
    expect(computer.providerRef).toBe(AGENT_A);
    await prepareAndExec(desk.sandbox, computer, "chief");
    expect(desk.urls.some((url) => url.includes("GetCapabilities"))).toBe(true);
    expect(desk.urls.every((url) => url.startsWith("http://127.0.0.1:1339/"))).toBe(true);
    expect(desk.urls.some((url) => url.includes("14020"))).toBe(false);
    expect(desk.seen.every((call) => call.display === "101" && call.agent === null)).toBe(true);
    expect(desk.seen.some((call) => call.display === "20")).toBe(false);
    expect((await desk.sandbox.connectScreen(computer, { view: "stream" }, context)).url).toBe(
      "http://127.0.0.1:6081?token=101",
    );
  });

  it("gives a bot that switches from dedicated to team its own desktop without a seat", async () => {
    const desk = teamMemberDesk(["staff"], new Map());
    const context = { ...ctx, botId: "staff" };
    const computer = await desk.sandbox.provision(
      { botId: "team-space", homePath: "/tmp", providerRef: "dedicated-staff" },
      context,
    );
    expect(computer.providerRef).toBe("dedicated-staff");
    await prepareAndExec(desk.sandbox, computer, "staff");
    expect(desk.urls[0]).toBe("http://127.0.0.1:1339/agent.v1.ControlService/GetCapabilities");
    expect(desk.urls.every((url) => url.startsWith("http://127.0.0.1:1339/"))).toBe(true);
    expect(desk.urls.some((url) => url.includes("14020"))).toBe(false);
    expect(desk.seen.every((call) => call.display === "101" && call.agent === null)).toBe(true);
    expect(desk.seen.every((call) => call.ownerLength > 16)).toBe(true);
    expect(desk.store.rows.get("staff")?.state).toBe("running");
    expect((await desk.sandbox.connectScreen(computer, { view: "stream" }, context)).url).toBe(
      "http://127.0.0.1:6081?token=101",
    );
  });

  it("checkpoints a running dedicated fake computer with no seat, then prepares on 1339", async () => {
    const members: string[] = [];
    const desk = teamMemberDesk(members, new Map());
    const root = await mkdtemp(path.join(tmpdir(), "rakazo-staff-home-"));
    const home = new LocalAgentHomeStore(root);
    const record = { id: "computer-staff", homeKey: "team-space" };
    const staffContext = { ...ctx, botId: "staff" };
    const fakeComputer = {
      id: "computer-staff",
      botId: "team-space",
      kind: "fake" as const,
      providerRef: "fake-staff",
    };
    try {
      await expect(
        checkpointRunningComputer(
          { home, sandbox: desk.sandbox, prisma: {} as never },
          record,
          fakeComputer,
          staffContext,
        ),
      ).resolves.toBeNull();
      await expect(
        checkpointRunningComputer(
          { home, sandbox: desk.sandbox, prisma: {} as never },
          record,
          { ...fakeComputer, kind: "sand" },
          staffContext,
        ),
      ).resolves.toBeNull();
      expect(desk.urls.some((url) => url.includes("14020"))).toBe(false);
      expect(desk.store.rows.has("staff")).toBe(false);

      members.push("staff");
      const computer = await desk.sandbox.provision(
        { botId: "team-space", homePath: "/tmp", providerRef: "fake-staff" },
        staffContext,
      );
      await prepareAndExec(desk.sandbox, computer, "staff");
      expect(desk.urls[0]).toBe("http://127.0.0.1:1339/agent.v1.ControlService/GetCapabilities");
      expect(desk.urls.every((url) => url.startsWith("http://127.0.0.1:1339/"))).toBe(true);
      expect(desk.urls.some((url) => url.includes("14020"))).toBe(false);
      expect(desk.seen.every((call) => call.display === "101" && call.agent === null)).toBe(true);
      const row = desk.store.rows.get("staff");
      expect(row?.displayIndex).toBeGreaterThanOrEqual(101);
      expect(row?.displayIndex).toBeLessThanOrEqual(150);
      expect(
        (await desk.sandbox.connectScreen(computer, { view: "stream" }, staffContext)).url,
      ).toBe("http://127.0.0.1:6081?token=101");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

class MemoryDeskStore implements TeamDesktopStore {
  readonly rows = new Map<string, TeamDesktopRecord>();

  async getByBot(botId: string) {
    const row = this.rows.get(botId);
    return row ? { ...row } : null;
  }

  async list() {
    return [...this.rows.values()].map((row) => ({ ...row }));
  }

  async insert(row: TeamDesktopRecord) {
    if ([...this.rows.values()].some((existing) => existing.botId === row.botId)) {
      throw Object.assign(new Error("unique"), { code: "P2002" });
    }
    if ([...this.rows.values()].some((existing) => existing.displayIndex === row.displayIndex)) {
      throw Object.assign(new Error("unique"), { code: "P2002" });
    }
    this.rows.set(row.botId, { ...row });
  }

  async update(botId: string, patch: Partial<Pick<TeamDesktopRecord, "state" | "lastUsedAt">>) {
    const row = this.rows.get(botId);
    if (!row) throw new Error(`missing ${botId}`);
    this.rows.set(botId, { ...row, ...patch });
  }

  async delete(botId: string) {
    this.rows.delete(botId);
  }
}

class QuietTeamDesktopHost implements TeamDesktopHost {
  private readonly alive = new Set<number>();

  async xSocketExists() {
    return false;
  }

  async tokenFileExists() {
    return false;
  }

  async portListening() {
    return false;
  }

  async windowAlive(displayIndex: number) {
    return this.alive.has(displayIndex);
  }

  async startWindow(displayIndex: number, _ownerToken: string) {
    this.alive.add(displayIndex);
  }

  async stopWindow(displayIndex: number) {
    this.alive.delete(displayIndex);
  }

  async purge() {}
}

function teamMemberDesk(members: readonly string[], seats: ReadonlyMap<string, string>) {
  const urls: string[] = [];
  const seen: Array<{ display: string | null; agent: string | null; ownerLength: number }> = [];
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    urls.push(url);
    const headers = new Headers(init?.headers);
    seen.push({
      display: headers.get(SAND_DISPLAY_HEADER),
      agent: headers.get(SAND_AGENT_HEADER),
      ownerLength: headers.get(SAND_WINDOW_OWNER_HEADER)?.length ?? 0,
    });
    if (url.endsWith("/agent.v1.ControlService/GetCapabilities")) {
      return Response.json({ computerUseSupported: true });
    }
    if (url.endsWith("/agent.v1.ControlService/Exec")) {
      return new Response(
        Buffer.concat([
          frame(0, { stdoutEvent: { data: "ok\n" } }),
          frame(0, { exitEvent: { exitCode: 0 } }),
          frame(2, {}),
        ]),
      );
    }
    return new Response("no", { status: 404 });
  });
  const store = new MemoryDeskStore();
  const sandbox = new SandSandboxProvider({
    policy: new MappedSandSeatPolicy(seats),
    host: new ConnectSandHost({
      baseUrl: "http://127.0.0.1:14020",
      token: "test-sand-token",
      fetch: fetchMock,
    }),
    teamDesktops: createTeamDesktopAllocator({
      store,
      host: new QuietTeamDesktopHost(),
      members: async () => members,
      now: () => new Date("2026-10-08T12:00:00.000Z"),
      sleep: async () => undefined,
    }),
  });
  return { sandbox, urls, seen, store };
}

async function prepareAndExec(
  sandbox: SandSandboxProvider,
  computer: Awaited<ReturnType<SandSandboxProvider["provision"]>>,
  botId: string,
) {
  const context = { ...ctx, botId };
  await sandbox.prepare(computer, context);
  for await (const event of sandbox.execute(
    computer,
    { argv: ["echo", "desk"], cwd: SAND_WORKSPACE },
    context,
  )) {
    if (event.type === "exit") expect(event.code).toBe(0);
  }
}

function lsArgv(body: unknown): boolean {
  return Array.isArray((body as { argv?: unknown }).argv)
    ? (body as { argv: string[] }).argv[0] === "ls"
    : false;
}

function frame(flags: number, value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(5);
  header[0] = flags;
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

function framedJson(body: BodyInit | null | undefined): Record<string, unknown> {
  const bytes = Buffer.from(body as Uint8Array);
  const length = bytes.readUInt32BE(1);
  return JSON.parse(bytes.subarray(5, 5 + length).toString("utf8")) as Record<string, unknown>;
}
