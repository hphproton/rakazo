import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { beforeEach, describe, expect, it } from "vitest";
import type { ScreenCapabilityScope } from "./screen-capability.js";
import {
  issueScreenCapability,
  openScreenCapability,
  REMOTE_SCREEN_CAPABILITY_MIN_REMAINING_MS,
  resetRemoteScreenCapabilityReuse,
  SCREEN_PROXY_TTL_MS,
  sealScreenCapability,
} from "./screen-capability.js";

const scope: ScreenCapabilityScope = {
  botId: "bot",
  computerId: "computer",
  botGeneration: 2,
  computerGeneration: 3,
  controlLeaseId: null,
};
/** Parse a relative seal the way a browser does, against the page that embedded it. */
function capabilityUrl(value: string, viewer = "http://viewer.invalid") {
  return new URL(value, viewer);
}

/**
 * Stock noVNC 1.7 `app/ui.js` `connect` when `host` is unset.
 * That is the default, and the seal does not set `host`.
 */
function stockNovncSocket(pageHref: string) {
  const path = new URL(pageHref).searchParams.get("path") ?? "websockify";
  const url = new URL(path, pageHref);
  url.protocol = new URL(pageHref).protocol === "https:" ? "wss:" : "ws:";
  url.search = "";
  url.hash = "";
  return url;
}

/** Custom embed: strip a leading slash and join onto the capability directory. */
function embedSocket(pageHref: string) {
  const page = new URL(pageHref);
  const path = (page.searchParams.get("path") ?? "websockify").replace(/^\//, "");
  const prefix = page.pathname.replace(/[^/]+$/, "");
  const protocol = page.protocol === "https:" ? "wss:" : "ws:";
  return new URL(`${protocol}//${page.host}${prefix}${path}`);
}

const path = (url: string, interactive = false) =>
  capabilityUrl(
    sealScreenCapability(
      `${url}?token=fake-provider-token&view_only=${!interactive}`,
      "fake-secret",
      "https://app.example",
      scope,
      100,
    ),
  ).pathname;
describe("sealed screen capabilities", () => {
  it.each([false, true])(
    "connects the shipped embed through one capability prefix (control=%s)",
    (interactive) => {
      const provider = new URL("http://127.0.0.1:49152/embed.html");
      provider.searchParams.set("view_only", String(!interactive));
      provider.searchParams.set("path", "websockify?token=fake-socket-token");
      const url = new URL(
        sealScreenCapability(provider.toString(), "fake-secret", "https://app.example", scope, 100),
        "https://app.example",
      );
      const html = readFileSync(
        new URL("../../../../infra/sandboxes/computer/embed.html", import.meta.url),
        "utf8",
      );
      const script = html
        .match(/<script type="module">([\s\S]*?)<\/script>/)![1]!
        .replace(/^\s*import[\s\S]*?;\s*$/gm, "");
      let socketUrl = "";
      runInNewContext(script, {
        document: { location: url, getElementById: () => ({}) },
        window: { location: url },
        RFB: class {
          constructor(_element: unknown, value: string) {
            socketUrl = value;
          }
        },
        attachHostClipboardPaste: () => {},
        attachMobilePaste: () => {},
        attachRemoteClipboardCopy: () => {},
        pasteHostText: () => false,
        // Embed imports are stripped for this smoke; stub the touch-keyboard
        // and trackpad bridges the same way as clipboard. Returning false
        // skips Keyboard / KeyTable / keysyms, which this harness does not provide.
        isTouchBrowser: () => false,
        attachMobileKeyboard: () => {},
        attachMobileTrackpad: () => {},
      });
      const socket = new URL(socketUrl);
      expect(socket.protocol).toBe("wss:");
      expect(socket.host).toBe(url.host);
      expect(socket.pathname).toBe(url.pathname.replace("/embed.html", "/websockify"));
      expect(socketUrl).not.toContain("fake-socket-token");
      expect(openScreenCapability(socket.pathname, "fake-secret", 101)?.target).toMatchObject({
        path: "/websockify?token=fake-socket-token",
        interactive,
      });
    },
  );
  it("hides provider credentials and binds scope and destination", () => {
    const value = path("https://screen.example/vnc.html");
    expect(value).not.toContain("fake-provider-token");
    expect(openScreenCapability(value, "fake-secret", 101)).toMatchObject({
      scope,
      target: {
        hostname: "screen.example",
        port: 443,
        protocol: "https:",
        interactive: false,
        path: "/vnc.html?token=fake-provider-token&view_only=true",
      },
    });
    expect(
      openScreenCapability(value.replace("/vnc.html", "/websockify"), "fake-secret", 101)?.target
        .path,
    ).toBe("/websockify?token=fake-provider-token&view_only=true");
  });
  it("keeps noVNC routing public and nested provider socket credentials sealed", () => {
    const provider = new URL("https://screen.example/vnc.html");
    provider.searchParams.set("path", "websockify?token=fake-socket-token");
    const sealed = sealScreenCapability(
      provider.toString(),
      "fake-secret",
      "https://app.example",
      scope,
      100,
    );
    expect(sealed.startsWith("/novnc/session/view/")).toBe(true);
    expect(sealed).not.toContain("://");
    expect(sealed).not.toContain("fake-socket-token");
    const url = capabilityUrl(sealed, "http://127.0.0.1:5173/");
    expect(url.searchParams.get("autoconnect")).toBe("true");
    expect(url.searchParams.get("path")).toBe("websockify");
    expect(url.searchParams.has("host")).toBe(false);
    const resolved = stockNovncSocket(url.href);
    expect(resolved.pathname).toBe(url.pathname.replace(/\/[^/]*$/, "/websockify"));
    // A capability prefix without a leading slash is relative to the page, so it nests.
    const nested = new URL("novnc/session/view/token/websockify", url);
    expect(nested.pathname).not.toBe(resolved.pathname);
    expect(openScreenCapability(resolved.pathname, "fake-secret", 101)?.target.path).toBe(
      "/websockify?token=fake-socket-token",
    );
  });

  it.each([
    ["http://machine.tailnet.ts.net:5173/bots/chief", "https://screen.example/vnc.html"],
    ["http://127.0.0.1:5173/", "https://screen.example/vnc.html"],
    ["http://machine.tailnet.ts.net:5173/bots/chief", "http://127.0.0.1:6080/embed.html"],
    ["http://127.0.0.1:5173/", "http://127.0.0.1:6080/embed.html"],
    ["http://machine.tailnet.ts.net:5173/", "http://127.0.0.1:6081/"],
    ["http://127.0.0.1:5173/", "http://127.0.0.1:6081/"],
  ])("viewer %s connects a seal of %s on its own origin", (viewer, upstream) => {
    const provider = new URL(upstream);
    provider.searchParams.set("path", "websockify?token=fake-socket-token");
    provider.searchParams.set("view_only", "true");
    const sealed = sealScreenCapability(
      provider.toString(),
      "fake-secret",
      "http://127.0.0.1:5173",
      scope,
      100,
    );
    expect(sealed.startsWith("/novnc/session/")).toBe(true);
    expect(sealed).not.toContain("://");
    const page = capabilityUrl(sealed, viewer);
    expect(page.host).toBe(new URL(viewer).host);
    expect(page.searchParams.get("path")).toBe("websockify");
    const stock = stockNovncSocket(page.href);
    const embed = embedSocket(page.href);
    expect(stock.protocol).toBe(page.protocol === "https:" ? "wss:" : "ws:");
    expect(stock.host).toBe(page.host);
    expect(embed.host).toBe(page.host);
    expect(stock.pathname).toBe(embed.pathname);
    expect(stock.pathname.endsWith("/websockify")).toBe(true);
    expect(stock.href).not.toContain("fake-socket-token");
    expect(openScreenCapability(stock.pathname, "fake-secret", 101)?.target.path).toBe(
      "/websockify?token=fake-socket-token",
    );
  });

  it("randomizes issuance even at the same timestamp", () => {
    expect(path("http://127.0.0.1:49152/embed.html")).not.toBe(
      path("http://127.0.0.1:49152/embed.html"),
    );
  });
  it("rejects wrong keys, modified policy, expiry and ciphertext", () => {
    const value = path("http://127.0.0.1:49152/embed.html");
    expect(openScreenCapability(value, "wrong", 101)).toBeNull();
    expect(
      openScreenCapability(value.replace("/view/", "/control/"), "fake-secret", 101),
    ).toBeNull();
    expect(
      openScreenCapability(value.replace("3600100.", "3600101."), "fake-secret", 101),
    ).toBeNull();
    expect(
      openScreenCapability(
        value.replace(/\.(.)/, (_, c) => `.${c === "a" ? "b" : "a"}`),
        "fake-secret",
        101,
      ),
    ).toBeNull();
    expect(openScreenCapability(value, "fake-secret", 100 + SCREEN_PROXY_TTL_MS)).toBeNull();
  });
  it("rejects truncated capability tokens before decryption", () => {
    const value = path("http://127.0.0.1:49152/embed.html");
    const match = value.match(/^(\/novnc\/session\/view\/\d+\.)([A-Za-z0-9_-]+)(\/.*)$/);
    expect(match).not.toBeNull();
    const truncated = `${match![1]}${match![2]!.slice(0, 8)}${match![3]}`;
    expect(openScreenCapability(truncated, "fake-secret", 101)).toBeNull();
  });
  it("enforces view policy and still serves relative assets", () => {
    const value = path("http://127.0.0.1:49152/embed.html");
    expect(
      openScreenCapability(`${value}?view_only=false`, "fake-secret", 101)?.target.path,
    ).toContain("view_only=true");
    expect(
      openScreenCapability(value.replace("/embed.html", "/core/rfb.js"), "fake-secret", 101)?.target
        .path,
    ).toBe("/core/rfb.js");
    expect(
      openScreenCapability(path("http://127.0.0.1:49152/embed.html", true), "fake-secret", 101)
        ?.target.interactive,
    ).toBe(true);
  });
  it.each(["http://public.example:49152/embed.html", "http://127.0.0.1:80/embed.html"])(
    "rejects disallowed local target %s",
    (url) => {
      expect(openScreenCapability(path(url), "fake-secret", 101)).toBeNull();
    },
  );
  it.each(["http://100.64.0.1:49152/embed.html", "http://100.127.255.254:49152/embed.html"])(
    "allows CGNAT 100.64/10 screen targets %s",
    (url) => {
      expect(openScreenCapability(path(url), "fake-secret", 101)?.target.hostname).toBe(
        new URL(url).hostname,
      );
    },
  );
  it.each(["http://100.63.255.255:49152/embed.html", "http://100.128.0.1:49152/embed.html"])(
    "rejects addresses outside CGNAT 100.64/10 %s",
    (url) => {
      expect(openScreenCapability(path(url), "fake-secret", 101)).toBeNull();
    },
  );
});

describe("remote screen capability reuse", () => {
  const upstream =
    "https://6100-sandbox.example/vnc.html?autoconnect=true&resize=scale&path=websockify%3Ftoken%3Dview-1&view_only=true";
  const issued = (now: number, nextScope = scope, url = upstream, secret = "fake-secret") =>
    issueScreenCapability(url, secret, "https://app.example", nextScope, now);

  beforeEach(() => {
    resetRemoteScreenCapabilityReuse();
  });

  it("reuses one remote seal across polls that a slow handshake can still be using", () => {
    const now = 1_000_000;
    const first = issued(now);
    const duringHandshake = issued(now + 5_000);
    expect(duringHandshake).toBe(first);
    const opened = openScreenCapability(capabilityUrl(first).pathname, "fake-secret", now + 5_000);
    expect(opened?.target.path).toBe(
      "/vnc.html?autoconnect=true&resize=scale&path=websockify%3Ftoken%3Dview-1&view_only=true",
    );
    expect(
      openScreenCapability(
        capabilityUrl(first).pathname.replace("/vnc.html", "/websockify"),
        "fake-secret",
        now + 5_000,
      )?.target.path,
    ).toBe("/websockify?token=view-1");
    expect(
      openScreenCapability(capabilityUrl(first).pathname, "fake-secret", now + SCREEN_PROXY_TTL_MS),
    ).toBeNull();
  });

  it("keeps the original expiry when a later client reads the cached seal", () => {
    const now = 1_000_000;
    const first = issued(now);
    const later = issued(now + 20 * 60_000);
    expect(later).toBe(first);
    const expiresAt = Number(capabilityUrl(later).pathname.match(/\/(\d+)\./)?.[1]);
    expect(expiresAt).toBe(now + SCREEN_PROXY_TTL_MS);
  });

  it("mints again once the held seal is inside the refresh window, without extending the old one", () => {
    const now = 1_000_000;
    const first = issued(now);
    const stillHeld = now + SCREEN_PROXY_TTL_MS - REMOTE_SCREEN_CAPABILITY_MIN_REMAINING_MS - 1;
    expect(issued(stillHeld)).toBe(first);
    const refreshAt = now + SCREEN_PROXY_TTL_MS - REMOTE_SCREEN_CAPABILITY_MIN_REMAINING_MS;
    const renewed = issued(refreshAt);
    expect(renewed).not.toBe(first);
    expect(
      openScreenCapability(capabilityUrl(first).pathname, "fake-secret", refreshAt),
    ).not.toBeNull();
    expect(
      openScreenCapability(capabilityUrl(first).pathname, "fake-secret", now + SCREEN_PROXY_TTL_MS),
    ).toBeNull();
    expect(
      openScreenCapability(capabilityUrl(renewed).pathname, "fake-secret", refreshAt),
    ).not.toBeNull();
    expect(
      openScreenCapability(
        capabilityUrl(renewed).pathname,
        "fake-secret",
        refreshAt + SCREEN_PROXY_TTL_MS,
      ),
    ).toBeNull();
  });

  it("rotates when the upstream token, scope, secret, or origin changes", () => {
    const now = 1_000_000;
    const first = issued(now);
    expect(issued(now + 1, scope, upstream.replace("view-1", "view-2"))).not.toBe(first);
    expect(
      issued(now + 1, { ...scope, computerGeneration: scope.computerGeneration + 1 }),
    ).not.toBe(first);
    expect(issued(now + 1, { ...scope, controlLeaseId: "lease" })).not.toBe(first);
    expect(issued(now + 1, scope, upstream, "other-secret")).not.toBe(first);
    expect(
      issueScreenCapability(upstream, "fake-secret", "https://other.example", scope, now + 1),
    ).not.toBe(first);
  });

  it("keeps minting a fresh capability for loopback screens", () => {
    const local = "http://127.0.0.1:49152/embed.html?path=websockify%3Ftoken%3Dview-1";
    expect(issued(1_000_000, scope, local)).not.toBe(issued(1_000_001, scope, local));
  });
});
