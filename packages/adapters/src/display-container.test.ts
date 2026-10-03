import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ProcessEvent } from "@rakazo/adapter-kit";
import { sandboxCommandTimeoutMs } from "@rakazo/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type DisplayContainerAttachment,
  DisplayContainerSandbox,
  type DisplaySpawn,
  displayContainerAttachments,
  displayExecArgs,
  displayWorkingDirectory,
} from "./display-container.js";
import { FakeSandboxProvider } from "./fake-sandbox.js";
import { createRunSandbox } from "./host-aware-sandbox.js";

const ctx = {
  operationId: "op",
  traceId: "tr",
  spaceId: "space",
  userId: "user",
  signal: new AbortController().signal,
};

function chiefAttachment(home: string): DisplayContainerAttachment {
  const [attachment] = displayContainerAttachments({});
  if (!attachment) throw new Error("missing display attachment");
  return { ...attachment, home };
}

function fakeChild(stdout: string, code = 0) {
  const child = new EventEmitter() as ChildProcess;
  child.stdout = new EventEmitter() as ChildProcess["stdout"];
  child.stderr = new EventEmitter() as ChildProcess["stderr"];
  child.kill = vi.fn();
  queueMicrotask(() => {
    child.stdout?.emit("data", Buffer.from(stdout));
    child.emit("close", code);
  });
  return child;
}

async function collect(events: AsyncIterable<ProcessEvent>) {
  const output: ProcessEvent[] = [];
  for await (const event of events) output.push(event);
  return output;
}

describe("display container attachment", () => {
  const previous = process.env.SANDBOX_DISPLAY_BOTS;

  afterEach(() => {
    if (previous === undefined) delete process.env.SANDBOX_DISPLAY_BOTS;
    else process.env.SANDBOX_DISPLAY_BOTS = previous;
  });

  it("keeps the built-in attachment on one container and lets an empty env attach nobody", () => {
    delete process.env.SANDBOX_DISPLAY_BOTS;
    const [attachment] = displayContainerAttachments();
    expect(attachment).toMatchObject({
      container: "rakazo-display-chief",
      home: "/workspace/rakazo-stack/bot-homes/chief",
    });
    expect(displayContainerAttachments({ SANDBOX_DISPLAY_BOTS: "" })).toEqual([]);
    expect(
      displayContainerAttachments({
        SANDBOX_DISPLAY_BOTS: "bot-z|rakazo-display-z|/tmp/bot-z",
      }),
    ).toEqual([{ botId: "bot-z", container: "rakazo-display-z", home: "/tmp/bot-z" }]);
    expect(() =>
      displayContainerAttachments({ SANDBOX_DISPLAY_BOTS: "bot-z|-rf|/tmp/bot-z" }),
    ).toThrow("display container name is invalid");
  });

  it("runs the attached bot inside the container and leaves every other bot on fake echo", async () => {
    const attachment = chiefAttachment("/opt/display-home");
    const spawn = vi.fn<DisplaySpawn>(() => fakeChild("from-container\n"));
    const sandbox = new DisplayContainerSandbox(new FakeSandboxProvider(), [attachment], spawn);
    const computer = await sandbox.provision({ botId: "team-home", homePath: "/unused" }, ctx);

    const chief = await collect(
      sandbox.execute(
        computer,
        { argv: ["uname"], cwd: `bots/${attachment.botId}`, env: { JOB: "1" } },
        { ...ctx, botId: attachment.botId },
      ),
    );
    expect(chief).toEqual([
      { type: "stdout", data: "from-container\n" },
      { type: "exit", code: 0 },
    ]);
    expect(spawn).toHaveBeenCalledTimes(1);
    const args = spawn.mock.calls[0]?.[1] ?? [];
    expect(args).toEqual(
      displayExecArgs(
        attachment,
        attachment.home,
        { JOB: "1" },
        ["uname"],
        sandboxCommandTimeoutMs(),
      ),
    );
    expect(args).toContain("rakazo-display-chief");
    expect(args).not.toContain("ran uname");

    const deputy = await collect(
      sandbox.execute(computer, { argv: ["uname"] }, { ...ctx, botId: "bot-deputy" }),
    );
    expect(deputy).toContainEqual({ type: "stdout", data: "ran uname\n" });
    expect(spawn).toHaveBeenCalledTimes(1);
    await sandbox.stop(computer, { ...ctx, botId: attachment.botId });
    await sandbox.destroy(computer, { ...ctx, botId: attachment.botId });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("refuses a working directory outside the container home", async () => {
    const attachment = chiefAttachment("/opt/display-home");
    const spawn = vi.fn<DisplaySpawn>(() => fakeChild("nope\n"));
    const sandbox = new DisplayContainerSandbox(new FakeSandboxProvider(), [attachment], spawn);
    const computer = await sandbox.provision({ botId: "team-home", homePath: "/unused" }, ctx);
    const events = await collect(
      sandbox.execute(
        computer,
        { argv: ["uname"], cwd: "/etc" },
        { ...ctx, botId: attachment.botId },
      ),
    );
    expect(events.map((event) => event.type)).toEqual(["stderr", "exit"]);
    expect(events[1]).toEqual({ type: "exit", code: 1 });
    expect(spawn).not.toHaveBeenCalled();
    expect(displayWorkingDirectory(attachment, `bots/${attachment.botId}`)).toBe(attachment.home);
  });

  it("reads and writes the attached home and does not follow a symlink out of it", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "rakazo-display-"));
    try {
      const attachment = chiefAttachment(home);
      const sandbox = new DisplayContainerSandbox(new FakeSandboxProvider(), [attachment]);
      const computer = await sandbox.provision({ botId: "team-home", homePath: "/unused" }, ctx);
      const chief = { ...ctx, botId: attachment.botId };
      await sandbox.writeFile(
        computer,
        { path: `bots/${attachment.botId}/notes/hello.txt`, content: Buffer.from("hello") },
        chief,
      );
      expect(
        new TextDecoder().decode(await sandbox.readFile(computer, "notes/hello.txt", chief)),
      ).toBe("hello");
      const listed = await sandbox.listFiles(computer, `bots/${attachment.botId}`, chief);
      expect(listed.map((entry) => entry.path)).toEqual(["notes"]);
      await symlink("/etc/hostname", path.join(home, "escape"));
      await expect(sandbox.readFile(computer, "escape", chief)).rejects.toThrow(
        "path is outside this computer's home",
      );
      await expect(
        sandbox.readFile(computer, "notes/hello.txt", { ...ctx, botId: "bot-deputy" }),
      ).rejects.toThrow("computer file not found");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("keeps a fake space wrapped and a docker space on docker", async () => {
    delete process.env.SANDBOX_DISPLAY_BOTS;
    const fake = createRunSandbox("fake", {});
    expect(fake.describe().id).toBe("fake");
    expect(fake).toBeInstanceOf(DisplayContainerSandbox);
    const computer = await fake.provision({ botId: "team-home", homePath: "/unused" }, ctx);
    const deputy = await collect(
      fake.execute(computer, { argv: ["uname"] }, { ...ctx, botId: "bot-deputy" }),
    );
    expect(deputy).toContainEqual({ type: "stdout", data: "ran uname\n" });
    expect(createRunSandbox("docker", {}).describe().id).toBe("docker");
    process.env.SANDBOX_DISPLAY_BOTS = "";
    expect(createRunSandbox("fake", {})).not.toBeInstanceOf(DisplayContainerSandbox);
  });
});
