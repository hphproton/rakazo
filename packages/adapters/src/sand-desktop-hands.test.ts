import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { HandExecResult } from "./sand-desktop-hands.js";
import {
  runTeamDesktopHand,
  TEAM_DESKTOP_SPAWN_SCRIPT,
  teamDesktopSpawnArgv,
  xdotoolClass,
} from "./sand-desktop-hands.js";
import { SAND_TEAM_BROWSER, sandTeamExecEnv } from "./sand-host.js";
import { sandWorkspacePath } from "./sand-sandbox.js";

function scripted(steps: HandExecResult[]) {
  const argv: string[][] = [];
  const exec = async (command: string[]) => {
    argv.push(command);
    const next = steps.shift();
    if (!next) throw new Error("unexpected exec");
    return next;
  };
  return { argv, exec };
}

const ok = { code: 0, stdout: "", stderr: "" };

describe("team desktop hands", () => {
  it("opens http and workspace paths with xdg-open", async () => {
    const http = scripted([ok]);
    await runTeamDesktopHand(
      { kind: "open", path: "https://example.com/a" },
      http.exec,
      sandWorkspacePath,
    );
    expect(http.argv).toEqual([teamDesktopSpawnArgv(["xdg-open", "https://example.com/a"])]);

    const file = scripted([ok]);
    await runTeamDesktopHand(
      { kind: "open", path: "notes/result.txt" },
      file.exec,
      sandWorkspacePath,
    );
    expect(file.argv).toEqual([teamDesktopSpawnArgv(["xdg-open", "/workspace/notes/result.txt"])]);
  });

  it("raises a matching window and otherwise starts it detached", async () => {
    const raised = scripted([{ code: 0, stdout: "4242\n", stderr: "" }, ok]);
    await runTeamDesktopHand(
      { kind: "focus", application: "xterm" },
      raised.exec,
      sandWorkspacePath,
    );
    expect(raised.argv).toEqual([
      ["xdotool", "search", "--class", "xterm"],
      ["xdotool", "windowactivate", "4242"],
    ]);

    const launched = scripted([{ code: 1, stdout: "", stderr: "" }, ok]);
    await runTeamDesktopHand(
      { kind: "focus", application: "google-chrome", uri: "https://example.com" },
      launched.exec,
      sandWorkspacePath,
    );
    expect(launched.argv).toEqual([
      ["xdotool", "search", "--class", "google-chrome"],
      teamDesktopSpawnArgv([SAND_TEAM_BROWSER, "https://example.com"]),
    ]);
  });

  it("forwards a uri into an existing browser window, then activates it", async () => {
    const host = scripted([{ code: 0, stdout: "7\n", stderr: "" }, ok, ok]);
    await runTeamDesktopHand(
      { kind: "focus", application: "chrome", uri: "https://example.com/tab" },
      host.exec,
      sandWorkspacePath,
    );
    expect(host.argv).toEqual([
      ["xdotool", "search", "--class", "google-chrome"],
      teamDesktopSpawnArgv([SAND_TEAM_BROWSER, "https://example.com/tab"]),
      ["xdotool", "windowactivate", "7"],
    ]);
  });

  it("launches without searching", async () => {
    const host = scripted([ok]);
    await runTeamDesktopHand(
      { kind: "launch", application: "xterm" },
      host.exec,
      sandWorkspacePath,
    );
    expect(host.argv).toEqual([teamDesktopSpawnArgv(["xterm"])]);
    const spawned = teamDesktopSpawnArgv(["xterm", "https://example.com/$(id)"]);
    expect(spawned[2]).toBe(TEAM_DESKTOP_SPAWN_SCRIPT);
    expect(spawned[2]).toContain('setsid "$@" </dev/null >/dev/null 2>&1 &');
    expect(spawned[2]).not.toContain("example.com");
    expect(spawned.slice(4)).toEqual(["0.2", "xterm", "https://example.com/$(id)"]);
    expect(teamDesktopSpawnArgv([SAND_TEAM_BROWSER])[4]).toBe("2.4");
  });

  it("refuses a path or shell in the application name", async () => {
    const host = scripted([]);
    await expect(
      runTeamDesktopHand(
        { kind: "launch", application: "/usr/bin/google-chrome" },
        host.exec,
        sandWorkspacePath,
      ),
    ).rejects.toThrow(/sand launch refused/);
    await expect(
      runTeamDesktopHand(
        { kind: "focus", application: "bash -c id" },
        host.exec,
        sandWorkspacePath,
      ),
    ).rejects.toThrow(/sand launch refused/);
    expect(host.argv).toEqual([]);
    expect(xdotoolClass("app.name+")).toBe("app\\.name\\+");
  });
});

function hasDesktopLauncher(): boolean {
  return (
    spawnSync("sh", [
      "-c",
      "command -v gtk-launch >/dev/null 2>&1 || command -v gio >/dev/null 2>&1",
    ]).status === 0
  );
}

function eachProc(visit: (pid: number, cmdline: string) => void) {
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      visit(Number(entry), readFileSync(`/proc/${entry}/cmdline`, "utf8"));
    } catch {
      // The process exited or its proc entry is gone.
    }
  }
}

function killEnding(args: string[]) {
  const needle = `${args.join("\0")}\0`;
  eachProc((pid, cmdline) => {
    if (cmdline.endsWith(needle)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
  });
}

function processExistsEnding(args: string[]): boolean {
  const needle = `${args.join("\0")}\0`;
  let found = false;
  eachProc((_pid, cmdline) => {
    if (cmdline.endsWith(needle)) found = true;
  });
  return found;
}

/** Same pipe shape as the exec daemon: stdin ignored, stdout and stderr piped. */
function pipedExec(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<HandExecResult> {
  const file = argv[0];
  if (!file) return Promise.reject(new Error("missing command"));
  return new Promise((resolve) => {
    const child = spawn(file, argv.slice(1), { stdio: ["ignore", "pipe", "pipe"], env });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: HandExecResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // The shell already exited; a grandchild may still hold the pipes.
      }
      finish({ code: 124, stdout, stderr: `${stderr}\nexec held the pipes` });
    }, 3_000);
    child.on("close", (code) => {
      finish({ code: code ?? 1, stdout, stderr });
    });
  });
}

describe("detached team desktop launch", () => {
  it("returns from two launches while the child stays up", async () => {
    const args = ["sleep", "29"];
    const started = Date.now();
    try {
      await runTeamDesktopHand(
        { kind: "launch", application: "sleep", uri: "29" },
        pipedExec,
        sandWorkspacePath,
      );
      await runTeamDesktopHand(
        { kind: "launch", application: "sleep", uri: "29" },
        pipedExec,
        sandWorkspacePath,
      );
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(processExistsEnding(args)).toBe(true);
    } finally {
      killEnding(args);
    }
  });

  it("errors when the application is not an executable or a desktop entry", async () => {
    const env = {
      ...process.env,
      XDG_DATA_HOME: "/nonexistent-rakazo-apps",
      XDG_DATA_DIRS: "/nonexistent-rakazo-apps",
    };
    await expect(
      runTeamDesktopHand(
        { kind: "launch", application: "terminal" },
        (argv) => pipedExec(argv, env),
        sandWorkspacePath,
      ),
    ).rejects.toThrow("application not found: terminal");
  });

  it("errors when the command exits immediately", async () => {
    await expect(
      runTeamDesktopHand({ kind: "launch", application: "false" }, pipedExec, sandWorkspacePath),
    ).rejects.toThrow("could not launch application: false");
  });

  it("launches a desktop entry that has no executable of that name", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "rakazo-desk-"));
    const desktop = path.join(root, "applications");
    mkdirSync(desktop);
    writeFileSync(
      path.join(desktop, "onlydesk.desktop"),
      "[Desktop Entry]\nType=Application\nName=Only Desk\nExec=/bin/sleep 28\n",
    );
    const env = { ...process.env, XDG_DATA_HOME: root, XDG_DATA_DIRS: "/nonexistent-rakazo-apps" };
    const launch = () =>
      runTeamDesktopHand(
        { kind: "launch", application: "onlydesk" },
        (argv) => pipedExec(argv, env),
        sandWorkspacePath,
      );
    try {
      if (hasDesktopLauncher()) {
        await launch();
        expect(processExistsEnding(["sleep", "28"])).toBe(true);
      } else {
        await expect(launch()).rejects.toThrow("could not launch application: onlydesk");
      }
    } finally {
      killEnding(["sleep", "28"]);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not let a child that writes stdout hold the exec call", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "rakazo-hold-"));
    const file = path.join(root, "hold");
    writeFileSync(file, "#!/bin/sh\nprintf held\nsleep 27\n");
    chmodSync(file, 0o755);
    const started = Date.now();
    try {
      const result = await pipedExec(teamDesktopSpawnArgv([file]));
      expect(result.code).toBe(0);
      expect(result.stdout).toBe("");
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(processExistsEnding([file])).toBe(true);
    } finally {
      killEnding([file]);
      killEnding(["sleep", "27"]);
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("team desktop exec env", () => {
  it("sets box-chrome and leaves PATH alone", () => {
    expect(sandTeamExecEnv(undefined)).toEqual({ BROWSER: SAND_TEAM_BROWSER });
    expect(sandTeamExecEnv({ DISPLAY: ":101", FOO: "bar" })).toEqual({
      FOO: "bar",
      BROWSER: SAND_TEAM_BROWSER,
    });
    expect(sandTeamExecEnv({ PATH: "/usr/bin:/bin", BROWSER: "/usr/bin/google-chrome" })).toEqual({
      PATH: "/usr/bin:/bin",
      BROWSER: "/usr/bin/google-chrome",
    });
    expect(sandTeamExecEnv({ PATH: "/usr/bin" }).PATH).toBe("/usr/bin");
  });
});
