import { createHash, randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { TERMINAL_INPUT, TERMINAL_RESIZE } from "@rakazo/contracts";
import { SAND_TEAM_BROWSER } from "./sand-host.js";
import { assertTeamDesktopIndex, teamDesktopPorts } from "./team-desktop.js";

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const PTY_SERVICE = "/agent.v1.PtyHostService";
const REQUEST = 1;
const RESPONSE = 3;
const RESPONSE_HEADERS = 4;
const RESPONSE_END = 5;
const ERROR = 6;

interface Session {
  displayIndex: number;
  controlToken: string;
  cwd: string;
}

interface PendingCall {
  stream: boolean;
  chunks: Buffer[];
  rest: Buffer;
  onData?: (bytes: Buffer) => void;
  settled: boolean;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

/**
 * Team-desktop PtyHost listens without an auth token. `start-window` omits
 * `--pty-auth-token`, and the daemon installs a guard only when that token is
 * set. This bridge speaks Rakazo terminal frames on a sealed loopback socket
 * and the PtyHost websocket on 127.0.0.1 only. The browser never sees 13600+N.
 */
export class SandPtyBridge {
  private server: http.Server | null = null;
  private listening: Promise<number> | null = null;
  private readonly sessions = new Map<string, Session>();
  private readonly sockets = new Map<Duplex, Session>();

  constructor(private readonly ptyPort: (displayIndex: number) => number = defaultPtyPort) {}

  async open(displayIndex: number, controlToken: string, cwd: string): Promise<string> {
    assertTeamDesktopIndex(displayIndex);
    if (!controlToken || controlToken.length > 200 || /[\r\n]/.test(controlToken)) {
      throw new Error("terminal requires a control token");
    }
    const port = await this.start();
    const token = randomUUID();
    this.sessions.set(token, { displayIndex, controlToken, cwd });
    const socketPath = `websockify?token=${encodeURIComponent(token)}`;
    return `http://127.0.0.1:${port}/vnc.html?view_only=false&path=${encodeURIComponent(socketPath)}`;
  }

  /** Drop shells bound to a released control lease. */
  release(controlToken: string) {
    for (const [token, session] of this.sessions) {
      if (session.controlToken === controlToken) this.sessions.delete(token);
    }
    for (const [socket, session] of this.sockets) {
      if (session.controlToken === controlToken) socket.destroy();
    }
  }

  close() {
    for (const socket of this.sockets.keys()) socket.destroy();
    this.server?.close();
    this.server = null;
    this.listening = null;
    this.sessions.clear();
    this.sockets.clear();
  }

  private start() {
    this.listening ??= new Promise<number>((resolve, reject) => {
      const server = http.createServer((_req, res) => {
        res.writeHead(404).end();
      });
      server.on("upgrade", (req, socket) => this.upgrade(req, socket));
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.unref();
        resolve((server.address() as AddressInfo).port);
      });
      this.server = server;
    });
    return this.listening;
  }

  private upgrade(req: http.IncomingMessage, socket: Duplex) {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const session = this.sessions.get(url.searchParams.get("token") ?? "");
    const key = req.headers["sec-websocket-key"];
    if (url.pathname !== "/websockify" || !session || typeof key !== "string") {
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    const accept = createHash("sha1")
      .update(key + WEBSOCKET_GUID)
      .digest("base64");
    const protocols = String(req.headers["sec-websocket-protocol"] ?? "")
      .split(",")
      .map((value) => value.trim());
    socket.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${accept}`,
        ...(protocols.includes("binary") ? ["Sec-WebSocket-Protocol: binary"] : []),
        "",
        "",
      ].join("\r\n"),
    );
    this.sockets.set(socket, session);
    socket.on("close", () => this.sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    void this.serve(socket, session);
  }

  private async serve(socket: Duplex, session: Session) {
    let client: PtyHostClient | undefined;
    let ptyId = "";
    let ending = false;
    const queued: Array<{ kind: number; payload: Buffer }> = [];
    const end = () => {
      if (ending) return;
      ending = true;
      void (async () => {
        if (client && ptyId) await client.unary("TerminatePty", { ptyId }).catch(() => undefined);
        client?.close();
        if (!socket.destroyed) socket.destroy();
      })();
    };
    let pending = Buffer.alloc(0);
    let frames = Buffer.alloc(0);
    const handle = (kind: number, payload: Buffer) => {
      if (!client || !ptyId) {
        queued.push({ kind, payload });
        return;
      }
      if (kind === TERMINAL_RESIZE && payload.length === 4) {
        void client
          .unary("ResizePty", {
            ptyId,
            cols: clampSize(payload.readUInt16BE(0)),
            rows: clampSize(payload.readUInt16BE(2)),
          })
          .catch(() => undefined);
      } else if (kind === TERMINAL_INPUT && payload.length > 0) {
        void client
          .unary("SendInput", { ptyId, data: payload.toString("base64") })
          .catch(() => undefined);
      }
    };
    socket.on("data", (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      for (;;) {
        const frame = decodeClientFrame(pending);
        if (!frame) break;
        pending = pending.subarray(frame.length);
        if (frame.opcode === 0x8) {
          end();
          return;
        }
        if (frame.opcode === 0x9) {
          socket.write(encodeServerFrame(0xa, frame.payload));
          continue;
        }
        if (frame.opcode > 0x2) continue;
        frames = Buffer.concat([frames, frame.payload]);
        while (frames.length >= 5) {
          const size = frames.readUInt32BE(1);
          if (frames.length < 5 + size) break;
          const kind = frames[0] ?? 0;
          const payload = Buffer.from(frames.subarray(5, 5 + size));
          frames = frames.subarray(5 + size);
          handle(kind, payload);
        }
      }
    });
    socket.on("close", end);
    try {
      client = await PtyHostClient.connect(this.ptyPort(session.displayIndex));
      const spawned = (await client.unary("SpawnPty", {
        cwd: session.cwd,
        cols: 80,
        rows: 24,
        env: { BROWSER: SAND_TEAM_BROWSER },
        process: { shell: "/bin/bash", args: ["-l"] },
      })) as { ptyId?: string; pty_id?: string };
      ptyId = spawned.ptyId || spawned.pty_id || "";
      if (!ptyId) throw new Error("pty host did not return an id");
      client.ptyId = ptyId;
      if (ending) {
        await client.unary("TerminatePty", { ptyId }).catch(() => undefined);
        client.close();
        return;
      }
      void client
        .stream("AttachPty", { ptyId }, (bytes) => {
          if (!socket.destroyed) socket.write(encodeServerFrame(0x2, bytes));
        })
        .catch(() => end());
      for (const frame of queued.splice(0)) handle(frame.kind, frame.payload);
    } catch {
      end();
    }
  }
}

function defaultPtyPort(displayIndex: number): number {
  return teamDesktopPorts(displayIndex).pty;
}

class PtyHostClient {
  ptyId = "";
  private next = 1;
  private readonly pending = new Map<string, PendingCall>();

  private constructor(private readonly ws: WebSocket) {
    ws.addEventListener("message", (event) => {
      void messageText(event.data).then((text) => this.onMessage(text));
    });
    ws.addEventListener("close", () => {
      for (const pending of this.pending.values()) pending.reject(new Error("pty host closed"));
      this.pending.clear();
    });
  }

  static connect(port: number): Promise<PtyHostClient> {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return Promise.reject(new Error("pty host unavailable"));
    }
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
      const client = new PtyHostClient(ws);
      const fail = () => {
        ws.close();
        reject(new Error("pty host unavailable"));
      };
      ws.addEventListener("open", () => resolve(client), { once: true });
      ws.addEventListener("error", fail, { once: true });
    });
  }

  unary(method: string, json: unknown): Promise<unknown> {
    return this.call(method, "application/json", Buffer.from(JSON.stringify(json)), false);
  }

  stream(method: string, json: unknown, onData: (bytes: Buffer) => void): Promise<unknown> {
    const payload = Buffer.from(JSON.stringify(json));
    const envelope = Buffer.alloc(5 + payload.length);
    envelope.writeUInt32BE(payload.length, 1);
    payload.copy(envelope, 5);
    return this.call(method, "application/connect+json", envelope, true, onData);
  }

  close() {
    this.ws.close();
  }

  private call(
    method: string,
    contentType: string,
    body: Buffer,
    stream: boolean,
    onData?: (bytes: Buffer) => void,
  ): Promise<unknown> {
    const requestId = String(this.next);
    this.next += 1;
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, {
        stream,
        chunks: [],
        rest: Buffer.alloc(0),
        onData,
        settled: false,
        resolve,
        reject,
      });
      this.ws.send(
        JSON.stringify({
          type: REQUEST,
          requestId,
          path: `${PTY_SERVICE}/${method}`,
          method: "POST",
          headers: {
            "content-type": contentType,
            "connect-protocol-version": "1",
          },
          body: body.toString("base64"),
        }),
      );
    });
  }

  private onMessage(text: string) {
    let message: {
      type?: number;
      requestId?: string;
      status?: number;
      body?: string;
      message?: string;
    };
    try {
      message = JSON.parse(text) as typeof message;
    } catch {
      return;
    }
    const requestId = message.requestId ?? "";
    const pending = this.pending.get(requestId);
    if (!pending) return;
    if (message.type === ERROR) {
      this.settle(requestId, () => pending.reject(new Error(message.message || "pty host failed")));
      return;
    }
    if (message.type === RESPONSE_HEADERS) {
      if ((message.status ?? 200) >= 400) {
        this.settle(requestId, () => pending.reject(new Error("pty host failed")));
      }
      return;
    }
    if (message.type === RESPONSE && message.body) {
      const bytes = Buffer.from(message.body, "base64");
      if (pending.stream) this.readStream(pending, bytes);
      else pending.chunks.push(bytes);
      return;
    }
    if (message.type === RESPONSE_END) {
      if (pending.stream) {
        this.settle(requestId, () => pending.resolve(undefined));
        return;
      }
      const raw = Buffer.concat(pending.chunks).toString("utf8");
      try {
        this.settle(requestId, () => pending.resolve(raw ? JSON.parse(raw) : {}));
      } catch {
        this.settle(requestId, () => pending.reject(new Error("pty host failed")));
      }
    }
  }

  private readStream(pending: PendingCall, bytes: Buffer) {
    pending.rest = Buffer.concat([pending.rest, bytes]);
    while (pending.rest.length >= 5) {
      const flags = pending.rest[0] ?? 0;
      const length = pending.rest.readUInt32BE(1);
      if (pending.rest.length < 5 + length) return;
      const payload = pending.rest.subarray(5, 5 + length);
      pending.rest = pending.rest.subarray(5 + length);
      if (flags & 0x02) {
        if (payload.length > 0) {
          try {
            const trailer = JSON.parse(payload.toString("utf8")) as {
              error?: { message?: string };
            };
            if (trailer.error) throw new Error(trailer.error.message || "pty stream failed");
          } catch (error) {
            pending.reject(error instanceof Error ? error : new Error("pty stream failed"));
          }
        }
        continue;
      }
      if (payload.length === 0 || !pending.onData) continue;
      try {
        const event = JSON.parse(payload.toString("utf8")) as {
          ptyData?: { data?: string };
          ptyExited?: { exitCode?: number };
        };
        if (event.ptyData?.data) pending.onData(Buffer.from(event.ptyData.data, "base64"));
      } catch {
        pending.reject(new Error("pty stream failed"));
      }
    }
  }

  private settle(requestId: string, finish: () => void) {
    const pending = this.pending.get(requestId);
    if (!pending || pending.settled) return;
    pending.settled = true;
    this.pending.delete(requestId);
    finish();
  }
}

function clampSize(value: number) {
  return Math.min(1000, Math.max(1, Math.round(value) || 1));
}

async function messageText(data: unknown): Promise<string> {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  }
  if (typeof Blob !== "undefined" && data instanceof Blob) return data.text();
  return "";
}

function encodeServerFrame(opcode: number, payload: Buffer) {
  const header =
    payload.length < 126
      ? Buffer.from([0x80 | opcode, payload.length])
      : payload.length < 65536
        ? Buffer.from([0x80 | opcode, 126, payload.length >> 8, payload.length & 0xff])
        : (() => {
            const long = Buffer.alloc(10);
            long[0] = 0x80 | opcode;
            long[1] = 127;
            long.writeBigUInt64BE(BigInt(payload.length), 2);
            return long;
          })();
  return Buffer.concat([header, payload]);
}

function decodeClientFrame(buffer: Buffer) {
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
      payload[index] = (payload[index] ?? 0) ^ (buffer[maskOffset + (index % 4)] ?? 0);
    }
  }
  return { opcode, payload, length: offset + size };
}
