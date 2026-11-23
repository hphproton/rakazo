import { Duplex, Readable, Writable } from "node:stream";
import { resolveSupervisorToken } from "@rakazo/core/node/secrets-guard";
import { deferred, flush } from "@rakazo/core/test-async";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { computerScreens } from "./screens.js";
import { browserProfilePathForScreen, computerCommandEnv } from "./supervisor-logic.js";

type ExecOptions = { Cmd: string[]; Env?: string[]; User?: string };

const mock = vi.hoisted(() => ({
  exec: vi.fn(),
  inspect: vi.fn(),
  failWhen: (_options: { Cmd: string[] }): boolean => false,
}));
vi.mock("dockerode", () => ({
  default: class {
    getContainer() {
      return mock;
    }
  },
}));

import { supervisorApp } from "./index.js";

beforeEach(() => {
  mock.exec.mockReset();
  mock.inspect.mockReset();
  mock.failWhen = () => false;
  mock.inspect.mockResolvedValue({
    Config: {
      Labels: { "rakazo.managed": "true", "rakazo.botId": "bot", "rakazo.spaceId": "space" },
    },
    State: { Running: true, StartedAt: "2026-01-01T00:00:00Z" },
    HostConfig: {},
  });
  mock.exec.mockImplementation(async (options: ExecOptions) => ({
    start: async () =>
      Duplex.from({
        readable: Readable.from([]),
        writable: new Writable({
          write(_chunk, _encoding, callback) {
            callback();
          },
        }),
      }),
    inspect: async () => ({ ExitCode: mock.failWhen(options) ? 1 : 0 }),
  }));
});

function post(path: string, body: unknown) {
  return supervisorApp.request(path, {
    method: "POST",
    headers: {
      authorization: `Bearer ${resolveSupervisorToken(process.env)}`,
      "content-type": "application/json",
      "x-rakazo-bot-id": "bot",
      "x-rakazo-space-id": "space",
    },
    body: JSON.stringify(body),
  });
}

const execs = () => mock.exec.mock.calls.map(([options]) => options as ExecOptions);

// Every exec, including file writes for uploads, inherits the container's non-root user
// (see containerCreateOptions) instead of naming one.
function expectContainerUser() {
  expect(execs().length).toBeGreaterThan(0);
  for (const options of execs()) expect(options).not.toHaveProperty("User");
}

describe("computer command identity", () => {
  it("runs the bot's commands with the workspace environment and the container's user", async () => {
    const response = await post("/computers/computer-exec/exec", {
      argv: ["echo", "hi"],
      env: { EXTRA: "1" },
    });
    await response.text();
    expect(execs().at(-1)?.Env).toEqual([
      ...computerCommandEnv({ display: ":1", debugPort: 9222 }),
      "EXTRA=1",
    ]);
    expectContainerUser();
  });

  it("keeps a silent command's response alive until it exits", async () => {
    vi.useFakeTimers();
    try {
      const exited = deferred<number>();
      mock.exec.mockImplementation(async () => ({
        start: async () => {
          const output = new Readable({ read() {} });
          void exited.promise.then(() => output.push(null));
          return Duplex.from({
            readable: output,
            writable: new Writable({
              write(_chunk, _encoding, callback) {
                callback();
              },
            }),
          });
        },
        inspect: async () => ({ ExitCode: await exited.promise }),
      }));
      const response = await post("/computers/computer-exec/exec", { argv: ["sleep", "600"] });
      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      await vi.advanceTimersByTimeAsync(15_000);
      expect(decoder.decode((await reader?.read())?.value)).toBe("\n");
      exited.resolve(0);
      let rest = "";
      for (;;) {
        const chunk = await reader?.read();
        if (!chunk || chunk.done) break;
        rest += decoder.decode(chunk.value);
      }
      expect(rest.trim().split("\n").at(-1)).toBe(JSON.stringify({ type: "exit", code: 0 }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops the keep-alive when the caller cancels a command that never exits", async () => {
    vi.useFakeTimers();
    const clear = vi.spyOn(globalThis, "clearInterval");
    try {
      mock.exec.mockImplementation(async () => ({
        start: async () =>
          Duplex.from({
            readable: new Readable({ read() {} }),
            writable: new Writable({
              write(_chunk, _encoding, callback) {
                callback();
              },
            }),
          }),
        inspect: async () => ({ ExitCode: 0 }),
      }));
      const response = await post("/computers/computer-exec/exec", { argv: ["sleep", "600"] });
      const reader = response.body?.getReader();
      await vi.advanceTimersByTimeAsync(15_000);
      await reader?.read();
      const before = vi.getTimerCount();
      await reader?.cancel();
      expect(clear).toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(before - 1);
    } finally {
      clear.mockRestore();
      vi.useRealTimers();
    }
  });

  it("starts the user's terminal with the same environment and user as the bot's shell", async () => {
    mock.failWhen = (options) => options.Cmd.join(" ").includes("terminal-fixture-token");
    const response = await post("/computers/computer-terminal/terminal", {
      controlToken: "terminal-fixture-token",
    });
    expect(response.status).toBe(400);
    const terminal = execs().find((options) =>
      options.Cmd.join(" ").includes("terminal-fixture-token"),
    );
    expect(terminal?.Env).toEqual(computerCommandEnv({ display: ":1", debugPort: 9222 }));
    expect(terminal?.Env?.[terminal.Env.indexOf("DISPLAY=:1") + 1]).toBe("RAKAZO_CDP_PORT=9222");
    expectContainerUser();
  });

  it("computer-exec-screen-cdp-port", async () => {
    const opened = mock.exec.getMockImplementation();
    mock.exec.mockImplementation(async (options: ExecOptions) => {
      if (!options.Cmd.includes("/usr/local/bin/rakazo-page-browser")) return opened?.(options);
      return {
        start: async () =>
          Duplex.from({
            readable: Readable.from([
              Buffer.from(
                JSON.stringify({
                  ok: true,
                  url: "https://example.test",
                  title: "Fixture",
                  tree: "",
                  elements: [],
                }),
              ),
            ]),
            writable: new Writable({
              write(_chunk, _encoding, callback) {
                callback();
              },
            }),
          }),
        inspect: async () => ({ ExitCode: 0 }),
      };
    });
    const computer = "computer-cdp";
    // One Team Computer. The container owner stays on x-rakazo-bot-id; each bot is a screen.
    const headers = (screenId: string) => ({
      authorization: `Bearer ${resolveSupervisorToken(process.env)}`,
      "content-type": "application/json",
      "x-rakazo-bot-id": "bot",
      "x-rakazo-space-id": "space",
      "x-rakazo-screen-id": screenId,
      "x-rakazo-screen-lease-id": `${screenId}:1`,
    });
    const open = (screenId: string) =>
      supervisorApp.request(`/computers/${computer}/browser`, {
        method: "POST",
        headers: headers(screenId),
        body: JSON.stringify({ command: "snapshot" }),
      });
    expect(await (await open("bot-a")).json()).toMatchObject({ ok: true });
    expect(await (await open("bot-b")).json()).toMatchObject({ ok: true });
    const shell = async (screenId: string) => {
      const response = await supervisorApp.request(`/computers/${computer}/exec`, {
        method: "POST",
        headers: headers(screenId),
        body: JSON.stringify({ argv: ["print-cdp", screenId] }),
      });
      expect(response.status).toBe(200);
      await response.text();
      return execs()
        .filter((options) => options.Cmd.includes("print-cdp") && options.Cmd.includes(screenId))
        .at(-1)?.Env;
    };
    const workspace = [
      "HOME=/home/rakazo",
      "PATH=/home/rakazo/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      "NPM_CONFIG_PREFIX=/home/rakazo/.local",
      "PIP_USER=1",
    ];
    expect(await shell("bot-b")).toEqual(["DISPLAY=:2", "RAKAZO_CDP_PORT=9223", ...workspace]);
    expect(await shell("bot-a")).toEqual(["DISPLAY=:1", "RAKAZO_CDP_PORT=9222", ...workspace]);
  });

  it("writes uploaded files as the container's user", async () => {
    const response = await post("/computers/computer-files/files", {
      path: "notes.txt",
      content: Buffer.from("hello").toString("base64"),
    });
    expect(response.status).toBe(200);
    expect(execs().at(-1)?.Cmd[0]).toBe("python3");
    expectContainerUser();
  });
});

const workspaceEnv = [
  "HOME=/home/rakazo",
  "PATH=/home/rakazo/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  "NPM_CONFIG_PREFIX=/home/rakazo/.local",
  "PIP_USER=1",
];
const screenLimitMessage = "This Team Computer cannot allocate another screen (limit 1).";
const newerLeaseMessage = "This Team Computer screen is owned by a newer execution.";

type SupervisorApp = typeof supervisorApp;

function authHeaders(screenId: string, botId = "bot", leaseId = `${screenId}:1`) {
  return {
    authorization: `Bearer ${resolveSupervisorToken(process.env)}`,
    "content-type": "application/json",
    "x-rakazo-bot-id": botId,
    "x-rakazo-space-id": "space",
    "x-rakazo-screen-id": screenId,
    "x-rakazo-screen-lease-id": leaseId,
  };
}

function scriptOf(options: ExecOptions): string {
  return options.Cmd.join("\n");
}

function isScreenReset(options: ExecOptions): boolean {
  return scriptOf(options).includes("for marker in /tmp/rakazo/browser-profile-");
}

function isScreenEnsure(options: ExecOptions, screenId: string): boolean {
  const script = scriptOf(options);
  return (
    script.includes(browserProfilePathForScreen(screenId)) && script.includes("desktop_view_token=")
  );
}

function installScreenExec() {
  mock.exec.mockImplementation(async (options: ExecOptions) => ({
    start: async () =>
      Duplex.from({
        readable: Readable.from([
          Buffer.from(
            options.Cmd.includes("/usr/local/bin/rakazo-page-browser")
              ? JSON.stringify({
                  ok: true,
                  url: "https://example.test",
                  title: "Fixture",
                  tree: "",
                  elements: [],
                })
              : "",
          ),
        ]),
        writable: new Writable({
          write(_chunk, _encoding, callback) {
            callback();
          },
        }),
      }),
    inspect: async () => ({ ExitCode: 0 }),
  }));
}

function openScreen(
  app: SupervisorApp,
  computer: string,
  screenId: string,
  leaseId = `${screenId}:1`,
) {
  return app.request(`/computers/${computer}/browser`, {
    method: "POST",
    headers: authHeaders(screenId, "bot", leaseId),
    body: JSON.stringify({ command: "snapshot" }),
  });
}

function execCommand(
  app: SupervisorApp,
  computer: string,
  screenId: string,
  argv: string[],
  leaseId = `${screenId}:1`,
  botId = "bot",
) {
  return app.request(`/computers/${computer}/exec`, {
    method: "POST",
    headers: authHeaders(screenId, botId, leaseId),
    body: JSON.stringify({ argv }),
  });
}

function openTerminal(app: SupervisorApp, computer: string, screenId: string, leaseId: string) {
  return app.request(`/computers/${computer}/terminal`, {
    method: "POST",
    headers: authHeaders(screenId, "bot", leaseId),
    body: JSON.stringify({ controlToken: "terminal-fixture-token" }),
  });
}

async function execEnv(
  app: SupervisorApp,
  computer: string,
  screenId: string,
  argv: string[],
  leaseId = `${screenId}:1`,
) {
  const response = await execCommand(app, computer, screenId, argv, leaseId);
  expect(response.status).toBe(200);
  await response.text();
  return execs().find((options) => options.Cmd.includes(argv[0] ?? ""))?.Env;
}

async function freshSupervisor() {
  vi.resetModules();
  const imported = await import("./index.js");
  const screens = await import("./screens.js");
  return { app: imported.supervisorApp, screens: screens.computerScreens };
}

describe("team computer exec screen slot", () => {
  beforeEach(() => {
    installScreenExec();
  });

  it("team-exec-unassigned-bot-own-slot", async () => {
    const computer = "computer-team-unassigned";
    expect(await (await openScreen(supervisorApp, computer, "bot-a")).json()).toMatchObject({
      ok: true,
    });
    expect(computerScreens.get(computer)?.has("bot-b")).toBe(false);
    mock.exec.mockClear();
    const env = await execEnv(supervisorApp, computer, "bot-b", ["print-cdp", "bot-b"]);
    expect(env).toEqual(["DISPLAY=:2", "RAKAZO_CDP_PORT=9223", ...workspaceEnv]);
    expect(computerScreens.get(computer)?.get("bot-b")?.index).toBe(1);
    // Registry already has bot-a's slot, so the first exec boots bot-b and then runs the command.
    expect(execs().filter(isScreenReset)).toHaveLength(0);
    expect(execs().filter((options) => isScreenEnsure(options, "bot-b"))).toHaveLength(1);
    expect(execs().filter((options) => scriptOf(options).includes("Xvfb :2"))).toHaveLength(1);
    expect(execs().filter((options) => options.Cmd.includes("print-cdp"))).toHaveLength(1);
    expect(execs()).toHaveLength(2);
  });

  it("keeps an unassigned personal exec on slot 0 without setting up a screen", async () => {
    const computer = "computer-personal-exec";
    mock.exec.mockClear();
    const env = await execEnv(supervisorApp, computer, "bot", ["personal-slot"], "bot:1");
    expect(env).toEqual(["DISPLAY=:1", "RAKAZO_CDP_PORT=9222", ...workspaceEnv]);
    expect(execs().filter(isScreenReset)).toHaveLength(0);
    expect(execs().some((options) => scriptOf(options).includes("desktop_view_token="))).toBe(
      false,
    );
    expect(execs().some((options) => scriptOf(options).includes("Xvfb"))).toBe(false);
    expect(execs()).toHaveLength(1);
    expect(computerScreens.get(computer)?.has("bot")).toBeFalsy();
  });

  it("reads an assigned team slot without setting up a screen", async () => {
    const computer = "computer-team-assigned";
    expect(await (await openScreen(supervisorApp, computer, "bot-a")).json()).toMatchObject({
      ok: true,
    });
    expect(await (await openScreen(supervisorApp, computer, "bot-b")).json()).toMatchObject({
      ok: true,
    });
    mock.exec.mockClear();
    const env = await execEnv(supervisorApp, computer, "bot-b", ["print-cdp", "bot-b"]);
    expect(env).toEqual(["DISPLAY=:2", "RAKAZO_CDP_PORT=9223", ...workspaceEnv]);
    expect(execs().filter(isScreenReset)).toHaveLength(0);
    expect(execs().filter((options) => isScreenEnsure(options, "bot-b"))).toHaveLength(0);
    expect(execs().some((options) => scriptOf(options).includes("desktop_view_token="))).toBe(
      false,
    );
    expect(execs()).toHaveLength(1);
  });

  it("uses a slot assigned while the exec waited for the screen lock", async () => {
    const releaseEnsure = deferred<void>();
    const ensureEntered = deferred<void>();
    const opened = mock.exec.getMockImplementation();
    if (!opened) throw new Error("docker exec mock is not installed");
    let held = false;
    mock.exec.mockImplementation(async (options: ExecOptions) => {
      if (!held && scriptOf(options).includes(browserProfilePathForScreen("bot-a"))) {
        held = true;
        ensureEntered.resolve();
        await releaseEnsure.promise;
      }
      return opened(options);
    });
    const computer = "computer-team-wait";
    const first = openScreen(supervisorApp, computer, "bot-a");
    await ensureEntered.promise;
    const inspects = () => mock.inspect.mock.calls.length;
    const beforeBrowser = inspects();
    const secondScreen = openScreen(supervisorApp, computer, "bot-b");
    await vi.waitFor(() => {
      expect(inspects()).toBeGreaterThan(beforeBrowser);
    });
    await flush();
    const beforeExec = inspects();
    const secondExec = execEnv(supervisorApp, computer, "bot-b", ["print-cdp", "bot-b"]);
    await vi.waitFor(() => {
      expect(inspects()).toBeGreaterThan(beforeExec);
    });
    await flush();
    releaseEnsure.resolve();
    expect(await (await first).json()).toMatchObject({ ok: true });
    expect(await (await secondScreen).json()).toMatchObject({ ok: true });
    expect(await secondExec).toEqual(["DISPLAY=:2", "RAKAZO_CDP_PORT=9223", ...workspaceEnv]);
    expect(execs().filter((options) => isScreenEnsure(options, "bot-b"))).toHaveLength(1);
  });

  it("releases the screen lock before a team exec command runs", async () => {
    const computer = "computer-team-lock";
    expect(await (await openScreen(supervisorApp, computer, "bot-a")).json()).toMatchObject({
      ok: true,
    });
    const releaseCommand = deferred<void>();
    const commandStarted = deferred<void>();
    const opened = mock.exec.getMockImplementation();
    if (!opened) throw new Error("docker exec mock is not installed");
    mock.exec.mockImplementation(async (options: ExecOptions) => {
      if (options.Cmd.includes("hang-bot")) {
        commandStarted.resolve();
        await releaseCommand.promise;
      }
      return opened(options);
    });
    const hanging = execCommand(supervisorApp, computer, "bot-b", ["hang-bot"]);
    try {
      await commandStarted.promise;
      let followed = false;
      const follower = (async () => {
        const response = await execCommand(supervisorApp, computer, "bot-c", ["follow-bot"]);
        expect(response.status).toBe(200);
        await response.text();
        followed = true;
      })();
      await Promise.race([follower, new Promise((resolve) => setTimeout(resolve, 2_000))]);
      expect(followed).toBe(true);
      const follow = execs().find((options) => options.Cmd.includes("follow-bot"));
      expect(follow?.Env).toEqual(["DISPLAY=:3", "RAKAZO_CDP_PORT=9224", ...workspaceEnv]);
    } finally {
      releaseCommand.resolve();
    }
    await (await hanging).text();
  });

  it("returns the terminal lease error and does not run the command", async () => {
    const computer = "computer-team-lease";
    expect(
      await (await openScreen(supervisorApp, computer, "bot-b", "run:2")).json(),
    ).toMatchObject({ ok: true });
    const terminal = await openTerminal(supervisorApp, computer, "bot-b", "run:1");
    expect(terminal.status).toBe(400);
    await expect(terminal.json()).resolves.toEqual({ error: newerLeaseMessage });
    const before = mock.exec.mock.calls.length;
    const response = await execCommand(
      supervisorApp,
      computer,
      "bot-b",
      ["should-not-run"],
      "run:1",
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: newerLeaseMessage });
    expect(execs().slice(before)).toHaveLength(0);
    expect(computerScreens.get(computer)?.get("bot-b")?.index).toBe(0);
  });

  it("re-assigns a team bot from an empty registry onto its own live slot", async () => {
    const computer = "computer-team-restart";
    expect(await (await openScreen(supervisorApp, computer, "bot-b")).json()).toMatchObject({
      ok: true,
    });
    expect(computerScreens.get(computer)?.get("bot-b")?.index).toBe(0);
    const { app, screens } = await freshSupervisor();
    expect(screens.has(computer)).toBe(false);
    expect(await (await openScreen(app, computer, "bot-a")).json()).toMatchObject({ ok: true });
    expect(screens.get(computer)?.get("bot-a")?.index).toBe(0);
    mock.exec.mockClear();
    const env = await execEnv(app, computer, "bot-b", ["print-cdp", "bot-b"]);
    expect(env).toEqual(["DISPLAY=:2", "RAKAZO_CDP_PORT=9223", ...workspaceEnv]);
    expect(screens.get(computer)?.get("bot-b")?.index).toBe(1);
    expect(execs().filter(isScreenReset)).toHaveLength(0);
    expect(execs().filter((options) => isScreenEnsure(options, "bot-b"))).toHaveLength(1);
    expect(execs().filter((options) => scriptOf(options).includes("Xvfb :2"))).toHaveLength(1);
  });

  it("rebuilds an empty registry during the first team exec", async () => {
    const { app, screens } = await freshSupervisor();
    const computer = "computer-team-restart-empty";
    mock.exec.mockClear();
    const env = await execEnv(app, computer, "bot-b", ["print-cdp", "bot-b"]);
    // The only bot is assigned index 0 by screen setup, which also records the registry.
    expect(env).toEqual(["DISPLAY=:1", "RAKAZO_CDP_PORT=9222", ...workspaceEnv]);
    expect(screens.get(computer)?.get("bot-b")?.index).toBe(0);
    expect(execs().filter(isScreenReset)).toHaveLength(1);
    expect(execs().filter((options) => isScreenEnsure(options, "bot-b"))).toHaveLength(1);
    expect(execs().filter((options) => options.Cmd.includes("print-cdp"))).toHaveLength(1);
    expect(execs()).toHaveLength(3);
  });

  it("returns the terminal limit error and does not run the command", async () => {
    vi.stubEnv("SANDBOX_TEAM_SCREEN_LIMIT", "1");
    try {
      const { app, screens } = await freshSupervisor();
      const computer = "computer-team-limit";
      expect(await (await openScreen(app, computer, "bot-a")).json()).toMatchObject({ ok: true });
      expect(screens.get(computer)?.get("bot-a")?.index).toBe(0);
      const terminal = await openTerminal(app, computer, "bot-b", "bot-b:1");
      expect(terminal.status).toBe(400);
      await expect(terminal.json()).resolves.toEqual({ error: screenLimitMessage });
      const before = mock.exec.mock.calls.length;
      const response = await execCommand(app, computer, "bot-b", ["should-not-run"]);
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: screenLimitMessage });
      expect(
        execs()
          .slice(before)
          .some((options) => options.Cmd.includes("should-not-run")),
      ).toBe(false);
      expect(execs().slice(before)).toHaveLength(0);
      expect(screens.get(computer)?.has("bot-b")).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
