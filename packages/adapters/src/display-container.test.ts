import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import type { ProcessEvent } from "@rakazo/adapter-kit";
import { sandboxCommandTimeoutMs } from "@rakazo/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DISPLAY_CONTAINER_TEMPLATE,
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

function chiefAttachment(): DisplayContainerAttachment {
  const [attachment] = displayContainerAttachments({});
  if (!attachment) throw new Error("missing display attachment");
  return attachment;
}

function fakeChild(stdout: string, code = 0) {
  const child = new EventEmitter() as ChildProcess;
  const stdin = new EventEmitter() as NonNullable<ChildProcess["stdin"]>;
  stdin.write = (() => true) as NonNullable<ChildProcess["stdin"]>["write"];
  stdin.end = (() => stdin) as NonNullable<ChildProcess["stdin"]>["end"];
  child.stdin = stdin;
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
      container: "team-b-chief-desktop",
      home: "/home/rakazo",
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
    expect(DISPLAY_CONTAINER_TEMPLATE).toEqual({
      image: "localhost/rakazo-desktop-vendored:hub-f",
      home: "/home/rakazo",
      display: ":1",
    });
    expect(attachment?.home).toBe(DISPLAY_CONTAINER_TEMPLATE.home);
  });

  it("attaches any bot from the same template and leaves an unlisted bot on fake echo", async () => {
    const attachments = displayContainerAttachments({
      SANDBOX_DISPLAY_BOTS:
        "bot-deputy|team-b-deputy-desktop,bot-other|team-b-other-desktop|/srv/other",
    });
    expect(attachments).toEqual([
      {
        botId: "bot-deputy",
        container: "team-b-deputy-desktop",
        home: DISPLAY_CONTAINER_TEMPLATE.home,
      },
      { botId: "bot-other", container: "team-b-other-desktop", home: "/srv/other" },
    ]);
    const deputy = attachments[0];
    if (!deputy) throw new Error("missing deputy attachment");
    const spawn = vi.fn<DisplaySpawn>(() => fakeChild("from-deputy\n"));
    const sandbox = new DisplayContainerSandbox(new FakeSandboxProvider(), attachments, spawn);
    const computer = await sandbox.provision({ botId: "team-home", homePath: "/unused" }, ctx);
    const events = await collect(
      sandbox.execute(
        computer,
        { argv: ["uname"], cwd: "bots/bot-deputy" },
        { ...ctx, botId: "bot-deputy" },
      ),
    );
    expect(events).toEqual([
      { type: "stdout", data: "from-deputy\n" },
      { type: "exit", code: 0 },
    ]);
    const args = spawn.mock.calls[0]?.[1] ?? [];
    expect(spawn.mock.calls[0]?.[0]).toBe("podman");
    expect(args[0]).toBe("exec");
    expect(args).toContain("team-b-deputy-desktop");
    expect(args).toContain(`HOME=${DISPLAY_CONTAINER_TEMPLATE.home}`);
    expect(args).toContain(`DISPLAY=${DISPLAY_CONTAINER_TEMPLATE.display}`);
    expect(args).not.toContain(DISPLAY_CONTAINER_TEMPLATE.image);
    expect(args).not.toContain("start");

    const unlisted = await collect(
      sandbox.execute(computer, { argv: ["uname"] }, { ...ctx, botId: "bot-unlisted" }),
    );
    expect(unlisted).toContainEqual({ type: "stdout", data: "ran uname\n" });
    expect(spawn).toHaveBeenCalledTimes(1);
    await sandbox.stop(computer, { ...ctx, botId: "bot-deputy" });
    await sandbox.destroy(computer, { ...ctx, botId: "bot-deputy" });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("runs the attached bot inside the container and leaves every other bot on fake echo", async () => {
    const attachment = chiefAttachment();
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
    expect(spawn.mock.calls[0]?.[0]).toBe("podman");
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
    expect(args).toContain("team-b-chief-desktop");
    expect(args).toContain("/home/rakazo");
    expect(args.filter((arg) => arg.startsWith("/"))).toEqual(["/home/rakazo"]);
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
    const attachment = chiefAttachment();
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

  it("reads and writes through podman exec and refuses a path that escapes the home", async () => {
    const attachment = chiefAttachment();
    const spawn = vi.fn<DisplaySpawn>(() => fakeChild(""));
    const sandbox = new DisplayContainerSandbox(new FakeSandboxProvider(), [attachment], spawn);
    const computer = await sandbox.provision({ botId: "team-home", homePath: "/unused" }, ctx);
    const chief = { ...ctx, botId: attachment.botId };
    await sandbox.writeFile(
      computer,
      { path: `bots/${attachment.botId}/notes/hello.txt`, content: Buffer.from("hello") },
      chief,
    );
    const writeArgs = spawn.mock.calls.at(-1)?.[1] ?? [];
    expect(spawn.mock.calls[0]?.[0]).toBe("podman");
    expect(writeArgs).toContain("team-b-chief-desktop");
    expect(writeArgs).toContain("/home/rakazo");
    expect(writeArgs).toContain("notes/hello.txt");

    spawn.mockImplementation(() => fakeChild("hello"));
    expect(
      new TextDecoder().decode(await sandbox.readFile(computer, "notes/hello.txt", chief)),
    ).toBe("hello");
    const readArgs = spawn.mock.calls.at(-1)?.[1] ?? [];
    expect(readArgs).toContain("notes/hello.txt");

    spawn.mockImplementation(() => fakeChild("d\t4096\t755\tnotes\n"));
    const listed = await sandbox.listFiles(computer, `bots/${attachment.botId}`, chief);
    expect(listed).toEqual([{ path: "notes", kind: "dir", size: 4096 }]);

    spawn.mockClear();
    await expect(sandbox.readFile(computer, "../etc/hostname", chief)).rejects.toThrow(
      "Path escapes the computer workspace",
    );
    expect(spawn).not.toHaveBeenCalled();
    await expect(
      sandbox.readFile(computer, "notes/hello.txt", { ...ctx, botId: "bot-deputy" }),
    ).rejects.toThrow("computer file not found");
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
