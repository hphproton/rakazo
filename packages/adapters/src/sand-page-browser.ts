import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { PageBrowserCommand, PageBrowserResult } from "@rakazo/adapter-kit";
import { teamDesktopPorts } from "./team-desktop.js";

const PAGE_BROWSER_TIMEOUT_MS = 25_000;
const PAGE_BROWSER_MAX_BYTES = 512 * 1024;
const UNAVAILABLE =
  "Page browser unavailable or interrupted. Inspect the screen before continuing.";

/** Stock CDP helper. The API process runs it against this desktop's box-chrome. */
export const SAND_PAGE_BROWSER_SCRIPT = fileURLToPath(
  new URL("../../../infra/sandboxes/computer/rakazo-page-browser", import.meta.url),
);

export function pageBrowserFallback(command: PageBrowserCommand["command"]): PageBrowserResult {
  return {
    ok: false,
    fallback: "computer_act",
    error: UNAVAILABLE,
    ...(command === "act" ? { uncertain: true } : {}),
  };
}

export async function runSandPageBrowser(input: {
  displayIndex: number;
  command: PageBrowserCommand;
  signal: AbortSignal;
  /** Tests substitute a stub. Production uses the stock helper. */
  scriptPath?: string;
}): Promise<PageBrowserResult> {
  const port = teamDesktopPorts(input.displayIndex).cdp;
  const script = input.scriptPath ?? SAND_PAGE_BROWSER_SCRIPT;
  try {
    return await runScript({
      script,
      command: input.command.command,
      body: JSON.stringify(input.command),
      display: `:${input.displayIndex}`,
      port: String(port),
      signal: input.signal,
    });
  } catch {
    return pageBrowserFallback(input.command.command);
  }
}

function runScript(input: {
  script: string;
  command: PageBrowserCommand["command"];
  body: string;
  display: string;
  port: string;
  signal: AbortSignal;
}): Promise<PageBrowserResult> {
  return new Promise((resolve) => {
    const child = spawn("python3", [input.script, input.command], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: process.env.HOME ?? "/tmp",
        LANG: process.env.LANG ?? "C.UTF-8",
        DISPLAY: input.display,
        RAKAZO_CDP_PORT: input.port,
        RAKAZO_BROWSER_ARGS_STDIN: "1",
        RAKAZO_BROWSER_WATCH_STDIN: "1",
      },
    });
    let stdout = "";
    let settled = false;
    const finish = (result: PageBrowserResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.signal.removeEventListener("abort", onAbort);
      child.stdin?.destroy();
      resolve(result);
    };
    const onAbort = () => {
      child.kill();
      finish(pageBrowserFallback(input.command));
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(pageBrowserFallback(input.command));
    }, PAGE_BROWSER_TIMEOUT_MS);
    input.signal.addEventListener("abort", onAbort);
    child.on("error", () => finish(pageBrowserFallback(input.command)));
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout) > PAGE_BROWSER_MAX_BYTES) child.kill();
    });
    child.stderr?.resume();
    child.on("close", () => {
      finish(parsePageBrowserResult(stdout, input.command));
    });
    child.stdin?.on("error", () => undefined);
    child.stdin?.write(`${input.body}\n`);
  });
}

function parsePageBrowserResult(
  stdout: string,
  command: PageBrowserCommand["command"],
): PageBrowserResult {
  const line = stdout.trim();
  if (!line || Buffer.byteLength(line) > PAGE_BROWSER_MAX_BYTES)
    return pageBrowserFallback(command);
  try {
    const parsed = JSON.parse(line) as PageBrowserResult;
    if (typeof parsed.ok !== "boolean") return pageBrowserFallback(command);
    return parsed;
  } catch {
    return pageBrowserFallback(command);
  }
}
