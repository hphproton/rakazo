import { describe, expect, it } from "vitest";
import type { HandExecResult } from "./sand-desktop-hands.js";
import { runTeamDesktopHand, xdotoolClass } from "./sand-desktop-hands.js";
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
    expect(http.argv).toEqual([["xdg-open", "https://example.com/a"]]);

    const file = scripted([ok]);
    await runTeamDesktopHand(
      { kind: "open", path: "notes/result.txt" },
      file.exec,
      sandWorkspacePath,
    );
    expect(file.argv).toEqual([["xdg-open", "/workspace/notes/result.txt"]]);
  });

  it("raises a matching window and falls back to setsid", async () => {
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
      ["setsid", "-f", SAND_TEAM_BROWSER, "https://example.com"],
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
      ["setsid", "-f", SAND_TEAM_BROWSER, "https://example.com/tab"],
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
    expect(host.argv).toEqual([["setsid", "-f", "xterm"]]);
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
