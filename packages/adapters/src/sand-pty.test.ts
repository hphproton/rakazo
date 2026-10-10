import { createHash } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import type { AdapterContext } from "@rakazo/adapter-kit";
import { encodeTerminalInput, encodeTerminalResize } from "@rakazo/contracts";
import { openScreenCapability, sealScreenCapability } from "@rakazo/core/node/screen-capability";
import { afterEach, describe, expect, it } from "vitest";
import type { SandHost } from "./sand-host.js";
import { SAND_TEAM_BROWSER } from "./sand-host.js";
import { SandPtyBridge } from "./sand-pty.js";
import { SandSandboxProvider } from "./sand-sandbox.js";

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const ctx: AdapterContext = {
  operationId: "1",
  traceId: "1",
  spaceId: "w",
  userId: "u",
  signal: new AbortController().signal,
};

interface Recorded {
  url: string;
  authorization: string | undefined;
  path: string;
  json: Record<string, unknown>;
}

class FakePtyHost {
  readonly requests: Recorded[] = [];
  port = 0;
  private server: http.Server | null = null;
  private attachId = "";

  async start() {
    await new Promise<void>((resolve) => {
      const server = http.createServer((_req, res) => {
        res.writeHead(404).end();
      });
      server.on("upgrade", (req, socket) => this.upgrade(req, socket));
      server.listen(0, "127.0.0.1", () => {
        this.port = (server.address() as AddressInfo).port;
        resolve();
      });
      this.server = server;
    });
  }

  close() {
    this.server?.close();
    this.server = null;
  }

  private upgrade(req: http.IncomingMessage, socket: Duplex) {
    const key = req.headers["sec-websocket-key"];
    if (typeof key !== "string") {
      socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      return;
    }
    const accept = createHash("sha1")
      .update(key + WEBSOCKET_GUID)
      .digest("base64");
    socket.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${accept}`,
        "",
        "",
      ].join("\r\n"),
    );
    const url = req.url ?? "/";
    const authorization = req.headers.authorization;
    let pending = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      for (;;) {
        const frame = decodeFrame(pending);
        if (!frame) break;
        pending = pending.subarray(frame.length);
        if (frame.opcode !== 0x1) continue;
        const message = JSON.parse(frame.payload.toString("utf8")) as {
          type?: number;
          requestId?: string;
          path?: string;
          body?: string;
        };
        if (message.type !== 1 || !message.requestId || !message.path || !message.body) continue;
        const json = decodeBody(message.path, message.body);
        this.requests.push({
          url,
          authorization: typeof authorization === "string" ? authorization : undefined,
          path: message.path,
          json,
        });
        this.reply(socket, message.requestId, message.path);
      }
    });
  }

  private reply(socket: Duplex, requestId: string, path: string) {
    const headers = (contentType: string) =>
      send(socket, { type: 4, requestId, status: 200, headers: { "content-type": contentType } });
    const end = () => send(socket, { type: 5, requestId, trailers: {} });
    if (path.endsWith("/SpawnPty")) {
      headers("application/json");
      send(socket, {
        type: 3,
        requestId,
        body: Buffer.from(JSON.stringify({ ptyId: "pty-1" })).toString("base64"),
      });
      end();
      return;
    }
    if (path.endsWith("/AttachPty")) {
      this.attachId = requestId;
      headers("application/connect+json");
      const event = Buffer.from(
        JSON.stringify({
          eventId: "1",
          ptyData: { data: Buffer.from("hello").toString("base64") },
        }),
      );
      const envelope = Buffer.alloc(5 + event.length);
      envelope.writeUInt32BE(event.length, 1);
      event.copy(envelope, 5);
      send(socket, { type: 3, requestId, body: envelope.toString("base64") });
      return;
    }
    headers("application/json");
    send(socket, {
      type: 3,
      requestId,
      body: Buffer.from(JSON.stringify({ success: true })).toString("base64"),
    });
    end();
    if (path.endsWith("/TerminatePty") && this.attachId) {
      send(socket, { type: 5, requestId: this.attachId, trailers: {} });
    }
  }
}

const closers: Array<() => void> = [];

afterEach(() => {
  for (const close of closers.splice(0)) close();
});

describe("sand pty bridge", () => {
  it("proxies Rakazo frames to an unauthenticated PtyHost and seals the loopback socket", async () => {
    const host = new FakePtyHost();
    await host.start();
    const bridge = new SandPtyBridge(() => host.port);
    closers.push(() => {
      bridge.close();
      host.close();
    });
    const idle: SandHost = {
      async capabilities() {
        return { computerUseSupported: true };
      },
      async *exec() {
        yield { type: "exit", code: 0 };
      },
      async listDirectory() {
        return [];
      },
      async readFile() {
        return new Uint8Array();
      },
      async writeFile() {},
      async computerUse() {
        return {};
      },
      screenUrl() {
        return null;
      },
    };
    const sandbox = new SandSandboxProvider({
      policy: { resolve: () => ({ agentId: "11111111-1111-4111-8111-111111111111" }) },
      host: idle,
      teamDesktops: {
        async resolve() {
          return undefined;
        },
        async ensure() {
          return { displayIndex: 121, ownerToken: "fixture-owner-token" };
        },
      },
      ptyBridge: bridge,
    });
    const computer = await sandbox.provision({ botId: "bot-a", homePath: "/tmp" }, ctx);
    const session = await sandbox.connectTerminal(
      computer,
      { controlToken: "lease-1", cwd: "bots/bot-a" },
      { ...ctx, botId: "bot-a" },
    );
    const page = new URL(session.url);
    expect(page.hostname).toBe("127.0.0.1");
    expect(page.searchParams.get("view_only")).toBe("false");
    expect(Number(page.port)).not.toBe(13600 + 121);
    const sealed = sealScreenCapability(session.url, "fake-secret", "https://app.example", {
      botId: "bot-a",
      computerId: "computer",
      botGeneration: 1,
      computerGeneration: 1,
      controlLeaseId: "lease-1",
    });
    const sealedPage = new URL(sealed, "https://app.example");
    const socketPath = new URL(sealedPage.searchParams.get("path") ?? "websockify", sealedPage);
    const opened = openScreenCapability(socketPath.pathname, "fake-secret");
    expect(opened?.target).toMatchObject({
      hostname: "127.0.0.1",
      port: Number(page.port),
      interactive: true,
    });
    expect(opened?.target.path.startsWith("/websockify?token=")).toBe(true);

    const bridgePath = page.searchParams.get("path") ?? "";
    const token = new URLSearchParams(bridgePath.slice(bridgePath.indexOf("?") + 1)).get("token");
    const ws = new WebSocket(`ws://127.0.0.1:${page.port}/websockify?token=${token}`);
    ws.binaryType = "arraybuffer";
    const output = new Promise<string>((resolve) => {
      ws.addEventListener("message", (event) => {
        const bytes =
          event.data instanceof ArrayBuffer
            ? Buffer.from(event.data)
            : Buffer.from(String(event.data));
        resolve(bytes.toString("utf8"));
      });
    });
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", () => reject(new Error("bridge upgrade failed")), {
        once: true,
      });
    });
    expect(await output).toBe("hello");
    const spawn = host.requests.find((call) => call.path.endsWith("/SpawnPty"));
    expect(spawn?.url).toBe("/");
    expect(spawn?.authorization).toBeUndefined();
    expect(spawn?.json).toEqual({
      cwd: "/workspace/bots/bot-a",
      cols: 80,
      rows: 24,
      env: { BROWSER: SAND_TEAM_BROWSER },
      process: { shell: "/bin/bash", args: ["-l"] },
    });
    expect(spawn?.json).not.toHaveProperty("PATH");

    ws.send(encodeTerminalInput("ls\n"));
    ws.send(encodeTerminalResize(100, 40));
    await viWait(() => host.requests.some((call) => call.path.endsWith("/SendInput")));
    await viWait(() => host.requests.some((call) => call.path.endsWith("/ResizePty")));
    const input = host.requests.find((call) => call.path.endsWith("/SendInput"));
    expect(Buffer.from(String(input?.json.data), "base64").toString("utf8")).toBe("ls\n");
    expect(host.requests.find((call) => call.path.endsWith("/ResizePty"))?.json).toMatchObject({
      ptyId: "pty-1",
      cols: 100,
      rows: 40,
    });

    ws.close();
    await viWait(() => host.requests.some((call) => call.path.endsWith("/TerminatePty")));
    await sandbox.setScreenControl(computer, false, ctx, "lease-1");
    await expect(
      openSocket(`ws://127.0.0.1:${page.port}/websockify?token=${token}`),
    ).rejects.toThrow(/failed/);
  });
});

function openSocket(url: string) {
  return new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.addEventListener("open", () => {
      ws.close();
      resolve();
    });
    ws.addEventListener("error", () => reject(new Error("failed")));
  });
}

async function viWait(ready: () => boolean) {
  const deadline = Date.now() + 2_000;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for pty host");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function decodeBody(path: string, body: string): Record<string, unknown> {
  const raw = Buffer.from(body, "base64");
  const json = path.endsWith("/AttachPty") ? raw.subarray(5) : raw;
  return JSON.parse(json.toString("utf8")) as Record<string, unknown>;
}

function send(socket: Duplex, value: unknown) {
  const payload = Buffer.from(JSON.stringify(value));
  const header =
    payload.length < 126
      ? Buffer.from([0x81, payload.length])
      : Buffer.from([0x81, 126, payload.length >> 8, payload.length & 0xff]);
  socket.write(Buffer.concat([header, payload]));
}

function decodeFrame(buffer: Buffer) {
  if (buffer.length < 2) return null;
  const opcode = (buffer[0] ?? 0) & 0x0f;
  const masked = ((buffer[1] ?? 0) & 0x80) !== 0;
  let size = (buffer[1] ?? 0) & 0x7f;
  let offset = 2;
  if (size === 126) {
    if (buffer.length < 4) return null;
    size = buffer.readUInt16BE(2);
    offset = 4;
  } else if (size === 127) {
    if (buffer.length < 10) return null;
    size = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }
  const maskOffset = offset;
  if (masked) offset += 4;
  if (buffer.length < offset + size) return null;
  const payload = Buffer.from(buffer.subarray(offset, offset + size));
  if (masked) {
    for (let index = 0; index < payload.length; index += 1) {
      const mask = buffer[maskOffset + (index % 4)] ?? 0;
      payload[index] = (payload[index] ?? 0) ^ mask;
    }
  }
  return { opcode, payload, length: offset + size };
}
