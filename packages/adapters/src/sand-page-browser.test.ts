import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { pageBrowserFallback, runSandPageBrowser } from "./sand-page-browser.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("sand page browser", () => {
  it("runs the helper with this desktop's display and CDP port", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "rakazo-page-browser-"));
    dirs.push(dir);
    const script = path.join(dir, "helper.py");
    await writeFile(
      script,
      [
        "import json, os",
        "print(json.dumps({",
        '  "ok": True,',
        '  "display": os.environ.get("DISPLAY"),',
        '  "port": os.environ.get("RAKAZO_CDP_PORT"),',
        '  "path": os.environ.get("PATH"),',
        "}))",
        "",
      ].join("\n"),
    );
    const result = await runSandPageBrowser({
      displayIndex: 121,
      command: { command: "snapshot" },
      signal: new AbortController().signal,
      scriptPath: script,
    });
    expect(result).toMatchObject({
      ok: true,
      display: ":121",
      port: "9343",
      path: process.env.PATH ?? "/usr/bin:/bin",
    });
  });

  it("returns the desktop fallback when the helper cannot attach", async () => {
    const missing = await runSandPageBrowser({
      displayIndex: 101,
      command: { command: "act", actions: [{ kind: "click", ref: "e1" }] },
      signal: new AbortController().signal,
      scriptPath: "/tmp/rakazo-page-browser-missing",
    });
    expect(missing).toEqual(pageBrowserFallback("act"));
    expect(missing.uncertain).toBe(true);
  });
});
