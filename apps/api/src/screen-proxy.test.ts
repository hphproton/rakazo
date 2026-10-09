import {
  resetRemoteScreenCapabilityReuse,
  SCREEN_TARGET_ENDPOINT,
} from "@rakazo/core/node/screen-capability";
import type { PrismaClient } from "@rakazo/db";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import {
  addScreenProxyCapability,
  keepSandScreenSeal,
  mountScreenTarget,
  sandScreenSealKey,
  takeSandScreenSeal,
} from "./screen-proxy.js";

const secret = "fake-screen-secret";
const scope = {
  botId: "bot",
  computerId: "computer",
  botGeneration: 0,
  computerGeneration: 0,
  controlLeaseId: "lease",
};
function fixture(
  interactive = false,
  upstream = `http://127.0.0.1:49152/embed.html?view_only=${!interactive}`,
) {
  const computer = {
    screenGeneration: 0,
    providerRef: "fake-provider",
    state: "running",
    controlHolder: "user",
    controlLeaseId: "lease",
    controlBotId: "bot",
    controlLeaseExpiresAt: new Date(Date.now() + 60_000),
  };
  const bot = {
    id: "bot",
    computerId: "computer",
    archivedAt: null as Date | null,
    screenGeneration: 0,
    computer,
  };
  const findFirst = vi.fn(async ({ where }) =>
    Object.entries(where).every(([key, value]) => bot[key as keyof typeof bot] === value)
      ? bot
      : null,
  );
  let desktop: { state: string } | null = null;
  const findUnique = vi.fn(async () => desktop);
  const app = new Hono();
  mountScreenTarget(
    app,
    { bot: { findFirst }, teamDesktop: { findUnique } } as unknown as PrismaClient,
    secret,
  );
  const url = addScreenProxyCapability(upstream, secret, "https://app.example", scope);
  const path = new URL(url).pathname;
  const request = (value = path, credential = secret) =>
    app.request(SCREEN_TARGET_ENDPOINT, {
      method: "POST",
      headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
      body: JSON.stringify({ path: value }),
    });
  return {
    bot,
    computer,
    findFirst,
    path,
    request,
    setDesktop(next: { state: string } | null) {
      desktop = next;
    },
  };
}

describe("screen capability lifecycle authorization", () => {
  it("allows repeat assets and reconnects during the same active lifecycle", async () => {
    const { request, path } = fixture();
    expect((await request()).status).toBe(200);
    expect((await request(path.replace("/embed.html", "/websockify"))).status).toBe(200);
    expect((await request()).headers.get("cache-control")).toBe("no-store");
  });
  it("requires the proxy credential before looking up a capability", async () => {
    const { request, findFirst, path } = fixture();
    expect((await request(path, "wrong")).status).toBe(403);
    expect(findFirst).not.toHaveBeenCalled();
  });
  it("rejects a seal while this bot's team desktop is not running", async () => {
    const { request, setDesktop, computer } = fixture();
    expect(computer.state).toBe("running");
    setDesktop({ state: "stopped" });
    expect((await request()).status).toBe(403);
    setDesktop({ state: "booting" });
    expect((await request()).status).toBe(403);
    setDesktop({ state: "running" });
    expect((await request()).status).toBe(200);
    setDesktop(null);
    expect((await request()).status).toBe(200);
  });
  it("rejects stopped computers and old URLs after restart at the same address", async () => {
    const { request, computer } = fixture();
    computer.state = "stopped";
    expect((await request()).status).toBe(403);
    computer.state = "running";
    computer.screenGeneration++;
    expect((await request()).status).toBe(403);
  });
  it.each(["suspending", "error", "stopped"])("rejects computer state %s", async (state) => {
    const { request, computer } = fixture();
    computer.state = state;
    expect((await request()).status).toBe(403);
  });
  it("revokes archived, reassigned, and restored bots", async () => {
    const { request, bot } = fixture();
    bot.archivedAt = new Date();
    expect((await request()).status).toBe(403);
    bot.archivedAt = null;
    bot.computerId = "other";
    expect((await request()).status).toBe(403);
    bot.computerId = "computer";
    bot.screenGeneration++;
    expect((await request()).status).toBe(403);
  });
  it.each(["expiry", "release", "replacement", "holder", "bot"])(
    "revokes control on lease %s",
    async (change) => {
      const { request, computer } = fixture(true);
      expect((await request()).status).toBe(200);
      if (change === "expiry") computer.controlLeaseExpiresAt = new Date(0);
      if (change === "release") computer.controlLeaseId = "";
      if (change === "replacement") computer.controlLeaseId = "new-lease";
      if (change === "holder") computer.controlHolder = "agent";
      if (change === "bot") computer.controlBotId = "other";
      expect((await request()).status).toBe(403);
    },
  );
  it("rejects legacy stateless capabilities", async () => {
    expect(
      (await fixture().request("/novnc/MTI3LjAuMC4x/49152/view/9999999999999.fake/embed.html"))
        .status,
    ).toBe(403);
  });
  it("reuses one remote capability across polls and still revokes it", async () => {
    resetRemoteScreenCapabilityReuse();
    const upstream =
      "https://6100-sandbox.example/vnc.html?autoconnect=true&resize=scale&path=websockify%3Ftoken%3Dview-1&view_only=true";
    const { path, request, computer } = fixture(false, upstream);
    const again = new URL(addScreenProxyCapability(upstream, secret, "https://app.example", scope))
      .pathname;
    expect(again).toBe(path);
    expect((await request()).status).toBe(200);
    expect((await request(again.replace("/vnc.html", "/websockify"))).status).toBe(200);
    computer.screenGeneration++;
    expect((await request()).status).toBe(403);
  });
  it("keeps minting a new capability for loopback screens", () => {
    const upstream = "http://127.0.0.1:49152/embed.html?view_only=true";
    const first = addScreenProxyCapability(upstream, secret, "https://app.example", scope);
    const second = addScreenProxyCapability(upstream, secret, "https://app.example", scope);
    expect(new URL(first).pathname).not.toBe(new URL(second).pathname);
  });
  it("passes desktop and other non-http screen URLs through unsealed", () => {
    expect(
      addScreenProxyCapability("desktop://screen/computer", secret, "https://app.example", scope),
    ).toBe("desktop://screen/computer");
    expect(addScreenProxyCapability("local://preview", secret, "https://app.example", scope)).toBe(
      "local://preview",
    );
  });
});

describe("sand screen seals", () => {
  const key = sandScreenSealKey({
    computerId: "computer-sand",
    interactive: false,
    botGeneration: 1,
    computerGeneration: 1,
    controlLeaseId: null,
    upstream: "http://127.0.0.1:6080/vnc.html?view_only=true",
  });

  it("reuses a seal until it is close to expiry", () => {
    const now = 1_700_000_000_000;
    const url = addScreenProxyCapability(
      "http://127.0.0.1:6080/vnc.html?view_only=true",
      secret,
      "http://127.0.0.1:5173",
      scope,
      now,
    );
    keepSandScreenSeal(key, url);
    expect(takeSandScreenSeal(key, now + 1_000)).toBe(url);
    expect(takeSandScreenSeal(key, now + 60 * 60_000 - 30_000)).toBeNull();
  });

  it("keeps a separate seal when the seat policy changes", () => {
    const now = 1_800_000_000_000;
    const url = addScreenProxyCapability(
      "http://127.0.0.1:6080/vnc.html?view_only=true",
      secret,
      "http://127.0.0.1:5173",
      scope,
      now,
    );
    keepSandScreenSeal(key, url);
    const control = sandScreenSealKey({
      computerId: "computer-sand",
      interactive: true,
      botGeneration: 1,
      computerGeneration: 1,
      controlLeaseId: null,
      upstream: "http://127.0.0.1:6080/vnc.html?view_only=false",
    });
    expect(takeSandScreenSeal(control, now + 1_000)).toBeNull();
    expect(takeSandScreenSeal(key, now + 1_000)).toBe(url);
  });
});
