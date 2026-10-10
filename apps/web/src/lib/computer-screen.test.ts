import { afterEach, describe, expect, it, vi } from "vitest";
import {
  embeddableScreenUrl,
  liveScreenInteractive,
  liveScreenSurfaces,
  loadComputerScreen,
  reuseScreenUrl,
  sandScreenSocketUrl,
  sandScreenViewOnly,
  screenIframeSandbox,
} from "./computer-screen";

describe("computer screen requests", () => {
  it("shows connection failures and lets a successful retry clear them", async () => {
    const commit = vi.fn();
    const options = {
      isCurrent: () => true,
      commit,
      fallbackError: "Could not connect",
    };
    await loadComputerScreen({
      ...options,
      load: async () => {
        throw new Error("Control stream failed to start");
      },
    });
    expect(commit).toHaveBeenLastCalledWith({
      url: null,
      error: "Control stream failed to start",
      botGeneration: null,
      computerGeneration: null,
    });

    await expect(
      loadComputerScreen({
        ...options,
        load: async () => ({ url: "https://screen.example/vnc.html" }),
      }),
    ).resolves.toBe("https://screen.example/vnc.html");
    expect(commit).toHaveBeenLastCalledWith({
      url: "https://screen.example/vnc.html",
      error: null,
      botGeneration: null,
      computerGeneration: null,
    });
  });

  it.each(["success", "failure"])(
    "ignores a stale %s after a newer screen failure",
    async (outcome) => {
      let finish!: (screen: { url: string | null }) => void;
      let fail!: (error: Error) => void;
      const deferred = new Promise<{ url: string | null }>((resolve, reject) => {
        finish = resolve;
        fail = reject;
      });
      let current = 1;
      const commit = vi.fn();
      const stale = loadComputerScreen({
        load: () => deferred,
        isCurrent: () => current === 1,
        commit,
        fallbackError: "Could not connect",
      });
      current = 2;
      await loadComputerScreen({
        load: async () => {
          throw new Error("Latest connection failed");
        },
        isCurrent: () => current === 2,
        commit,
        fallbackError: "Could not connect",
      });
      if (outcome === "success") finish({ url: "https://stale.example/vnc.html" });
      else fail(new Error("Stale connection failed"));
      await expect(stale).resolves.toBeNull();
      expect(commit).toHaveBeenCalledExactlyOnceWith({
        url: null,
        error: "Latest connection failed",
        botGeneration: null,
        computerGeneration: null,
      });
    },
  );

  it("uses the visible fallback for errors without a message", async () => {
    const commit = vi.fn();
    await loadComputerScreen({
      load: async () => Promise.reject(null),
      isCurrent: () => true,
      commit,
      fallbackError: "Could not connect",
    });
    expect(commit).toHaveBeenCalledExactlyOnceWith({
      url: null,
      error: "Could not connect",
      botGeneration: null,
      computerGeneration: null,
    });
  });
});

describe("reuseScreenUrl", () => {
  const now = 1_700_000_000_000;
  const live = (policy: "view" | "control", expires: number, token: string) =>
    `http://127.0.0.1:5173/novnc/session/${policy}/${expires}.${token}/vnc.html?path=/novnc/session/${policy}/${expires}.${token}/websockify`;
  const generation = (computer: number, bot = 0) => ({ bot, computer });

  it("keeps the current seal on a same-generation repoll", () => {
    const current = live("view", now + 30 * 60_000, "current-token");
    const rotated = live("view", now + 50 * 60_000, "rotated-token");
    const same = {
      held: generation(171),
      next: generation(171),
    };
    expect(reuseScreenUrl(current, rotated, now, same)).toBe(current);
    expect(reuseScreenUrl(current, current, now, same)).toBe(current);
    expect(
      reuseScreenUrl(current, live("view", now + 50 * 60_000, "soon"), now + 29 * 60_000, same),
    ).toBe(live("view", now + 50 * 60_000, "soon"));
  });

  it("adopts the fresh seal when the computer generation changes", () => {
    const current = live("view", now + 50 * 60_000, "revoked-token");
    const fresh = live("view", now + 60 * 60_000, "fresh-token");
    expect(
      reuseScreenUrl(current, fresh, now, {
        held: generation(171),
        next: generation(174),
      }),
    ).toBe(fresh);
    expect(
      reuseScreenUrl(current, fresh, now, {
        held: generation(171, 0),
        next: generation(171, 1),
      }),
    ).toBe(fresh);
  });

  it("adopts the server url when the generation is unknown", () => {
    const current = live("view", now + 50 * 60_000, "current-token");
    const fresh = live("view", now + 60 * 60_000, "fresh-token");
    expect(reuseScreenUrl(current, fresh, now)).toBe(fresh);
    expect(reuseScreenUrl(current, fresh, now, { held: generation(171), next: null })).toBe(fresh);
    expect(reuseScreenUrl(current, fresh, now, { held: null, next: generation(174) })).toBe(fresh);
  });

  it("does not reuse a control seal, and a rejection takes the server url", () => {
    const current = live("control", now + 30 * 60_000, "old-lease");
    const fresh = live("control", now + 50 * 60_000, "new-lease");
    const same = { held: generation(171), next: generation(171) };
    expect(reuseScreenUrl(current, fresh, now, same)).toBe(fresh);
    const view = live("view", now + 30 * 60_000, "view-token");
    const rotated = live("view", now + 50 * 60_000, "rotated-token");
    expect(reuseScreenUrl(view, rotated, now, same)).toBe(view);
    expect(reuseScreenUrl(view, rotated, now, same, true)).toBe(rotated);
  });

  it("takes a new url when the policy changes or the url is not sealed noVNC", () => {
    const current = live("view", now + 120_000, "current-token");
    const control = live("control", now + 300_000, "control-token");
    const same = { held: generation(171), next: generation(171) };
    expect(reuseScreenUrl(current, control, now, same)).toBe(control);
    expect(reuseScreenUrl(current, "https://screen.example/vnc.html", now, same)).toBe(
      "https://screen.example/vnc.html",
    );
    expect(reuseScreenUrl(null, control, now)).toBe(control);
    expect(reuseScreenUrl(current, null, now)).toBeNull();
  });
});

describe("live screen surfaces", () => {
  it("mounts only the overlay while it is open, and only the overlay is interactive", () => {
    expect(liveScreenSurfaces(true)).toEqual(["overlay"]);
    expect(liveScreenSurfaces(false)).toEqual(["card"]);
    expect(liveScreenInteractive("overlay")).toBe(true);
    expect(liveScreenInteractive("card")).toBe(false);
  });
});

describe("embeddableScreenUrl", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("hides a local screen whose port does not match the page", () => {
    vi.stubGlobal("window", { location: { href: "http://localhost:5173/" } });
    expect(embeddableScreenUrl("http://127.0.0.1:6080/vnc.html")).toBeNull();
    expect(embeddableScreenUrl("http://localhost:6080/vnc.html")).toBeNull();
  });

  it("keeps a non-local screen even when the port differs", () => {
    vi.stubGlobal("window", { location: { href: "http://localhost:5173/" } });
    expect(embeddableScreenUrl("https://screen.example:6080/vnc.html")).toBe(
      "https://screen.example:6080/vnc.html",
    );
  });

  it.each(["http://machine.tailnet.ts.net:5173/bots/chief", "http://127.0.0.1:5173/"])(
    "resolves a relative seal against the page %s",
    (href) => {
      vi.stubGlobal("window", { location: { href } });
      const sealed =
        "/novnc/session/view/1710000000000.token/vnc.html?autoconnect=true&resize=scale&view_only=true&path=websockify";
      const page = new URL(href);
      expect(embeddableScreenUrl(sealed)).toBe(new URL(sealed, page).href);
      expect(new URL(embeddableScreenUrl(sealed) ?? "").host).toBe(page.host);
    },
  );
});

describe("sandScreenSocketUrl", () => {
  const sealed = (policy: "view" | "control", token = "sealed-token") =>
    `https://app.example/novnc/session/${policy}/1710000000000.${token}/vnc.html?autoconnect=true&resize=scale&view_only=${policy === "control" ? "false" : "true"}&path=/novnc/session/${policy}/1710000000000.${token}/websockify`;

  it("uses the sealed session websockify and not the vnc.html page", () => {
    expect(sandScreenSocketUrl(sealed("view"), "https://app.example/app")).toBe(
      "wss://app.example/novnc/session/view/1710000000000.sealed-token/websockify",
    );
    expect(sandScreenSocketUrl(sealed("control"), "https://app.example/app")).toBe(
      "wss://app.example/novnc/session/control/1710000000000.sealed-token/websockify",
    );
  });

  it.each(["http://machine.tailnet.ts.net:5173/bots/chief", "http://127.0.0.1:5173/"])(
    "opens a relative seal on the viewer %s",
    (base) => {
      const sealed =
        "/novnc/session/view/1710000000000.token/vnc.html?autoconnect=true&resize=scale&view_only=true&path=websockify";
      const socket = sandScreenSocketUrl(sealed, base);
      const viewer = new URL(base);
      expect(socket).toBe(
        `${viewer.protocol === "https:" ? "wss" : "ws"}://${viewer.host}/novnc/session/view/1710000000000.token/websockify`,
      );
    },
  );

  it("keeps a relative websockify path inside the sealed directory", () => {
    expect(
      sandScreenSocketUrl(
        "http://127.0.0.1:5173/novnc/session/view/1710000000000.token/embed.html?path=websockify",
        "http://127.0.0.1:5173/",
      ),
    ).toBe("ws://127.0.0.1:5173/novnc/session/view/1710000000000.token/websockify");
  });

  it("ignores a path query that leaves the sealed session", () => {
    const page =
      "https://app.example/novnc/session/view/1710000000000.token/vnc.html?path=https%3A%2F%2Fevil.example%2Fwebsockify";
    expect(sandScreenSocketUrl(page, "https://app.example/")).toBe(
      "wss://app.example/novnc/session/view/1710000000000.token/websockify",
    );
  });

  it("does not invent a socket for a page that is not a sealed noVNC session", () => {
    expect(
      sandScreenSocketUrl("https://screen.example/vnc.html", "https://app.example/"),
    ).toBeNull();
    expect(sandScreenSocketUrl(null, "https://app.example/")).toBeNull();
  });
});

describe("sandScreenViewOnly", () => {
  it("stays view-only until the surface is interactive and the seal allows control", () => {
    const control =
      "https://app.example/novnc/session/control/1.token/vnc.html?view_only=false&path=/novnc/session/control/1.token/websockify";
    const view =
      "https://app.example/novnc/session/view/1.token/vnc.html?view_only=true&path=/novnc/session/view/1.token/websockify";
    expect(sandScreenViewOnly(control, false)).toBe(true);
    expect(sandScreenViewOnly(view, true)).toBe(true);
    expect(sandScreenViewOnly(control, true)).toBe(false);
  });
});

describe("screenIframeSandbox", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("allows scripts and pointer lock only for /novnc/ paths", () => {
    vi.stubGlobal("window", { location: { href: "http://localhost:5173/" } });
    expect(screenIframeSandbox("http://127.0.0.1:5173/novnc/vnc.html")).toBe(
      "allow-scripts allow-pointer-lock",
    );
    expect(screenIframeSandbox("http://127.0.0.1:5173/vnc.html")).toBeUndefined();
  });
});
