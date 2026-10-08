// @vitest-environment jsdom

import type { ComputerStatus } from "@rakazo/contracts";
import { openScreenCapability, sealScreenCapability } from "@rakazo/core/node/screen-capability";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sandScreenSocketUrl } from "../../lib/computer-screen";
import { ComputerLiveScreen, SAND_SCREEN_RETRY_MS } from "./ComputerLiveScreen";

type MockClient = {
  url: string;
  shared: boolean;
  viewOnly: boolean;
  scaleViewport: boolean;
  resizeSession: boolean;
  focusOnClick: boolean;
  disconnect: ReturnType<typeof vi.fn>;
  emitDisconnect: (clean: boolean) => void;
};

const clients: MockClient[] = [];

vi.mock("@novnc/novnc", () => ({
  default: class MockRFB {
    viewOnly = false;
    scaleViewport = false;
    resizeSession = true;
    background = "";
    focusOnClick = true;
    disconnect = vi.fn();
    private readonly handlers = new Map<string, Array<(event: Event) => void>>();
    constructor(_target: HTMLElement, url: string, options?: { shared?: boolean }) {
      const self = this;
      clients.push({
        url,
        shared: options?.shared === true,
        get viewOnly() {
          return self.viewOnly;
        },
        get scaleViewport() {
          return self.scaleViewport;
        },
        get resizeSession() {
          return self.resizeSession;
        },
        get focusOnClick() {
          return self.focusOnClick;
        },
        disconnect: this.disconnect,
        emitDisconnect(clean: boolean) {
          const event = new CustomEvent("disconnect", { detail: { clean } });
          for (const handler of self.handlers.get("disconnect") ?? []) handler(event);
        },
      });
    }
    addEventListener(type: string, handler: (event: Event) => void) {
      const list = this.handlers.get(type) ?? [];
      list.push(handler);
      this.handlers.set(type, list);
    }
  },
}));

const SEALED =
  "https://app.example/novnc/session/view/1710000000000.sealed-token/vnc.html?autoconnect=true&resize=scale&view_only=true&path=/novnc/session/view/1710000000000.sealed-token/websockify";
const CONTROL =
  "https://app.example/novnc/session/control/1710000000000.sealed-token/vnc.html?autoconnect=true&resize=scale&view_only=false&path=/novnc/session/control/1710000000000.sealed-token/websockify";

const CHROME = ["Idle", "Open full", "Copy link", "Connected", "Reconnecting", "Stale"];

function screen(
  kind: ComputerStatus["kind"],
  url: string,
  pointerEvents: "none" | "auto" = "none",
) {
  return (
    <ComputerLiveScreen
      kind={kind}
      url={url}
      title={pointerEvents === "none" ? "Bot screen preview" : "Bot screen"}
      allow={
        pointerEvents === "none"
          ? "clipboard-read; clipboard-write"
          : "clipboard-read; clipboard-write; fullscreen"
      }
      pointerEvents={pointerEvents}
    />
  );
}

async function renderScreen(
  kind: ComputerStatus["kind"],
  url: string,
  pointerEvents: "none" | "auto" = "none",
) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(screen(kind, url, pointerEvents));
  });
  await act(async () => {
    await Promise.resolve();
  });
  return {
    container,
    async rerender(
      nextKind: ComputerStatus["kind"],
      nextUrl: string,
      nextPointer: "none" | "auto" = pointerEvents,
    ) {
      await act(async () => {
        root.render(screen(nextKind, nextUrl, nextPointer));
      });
      await act(async () => {
        await Promise.resolve();
      });
    },
    async cleanup() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

afterEach(() => {
  clients.splice(0, clients.length);
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe("ComputerLiveScreen", () => {
  it("draws sand with an in-app RFB client and does not load vnc.html", async () => {
    const view = await renderScreen("sand", SEALED);
    expect(view.container.querySelector("iframe")).toBeNull();
    expect(view.container.querySelector("[data-testid='sand-screen-frame']")).not.toBeNull();
    expect(view.container.innerHTML).not.toContain("vnc.html");
    expect(clients).toHaveLength(1);
    expect(clients[0]?.url).toBe(
      "wss://app.example/novnc/session/view/1710000000000.sealed-token/websockify",
    );
    expect(clients[0]?.shared).toBe(true);
    expect(clients[0]?.viewOnly).toBe(true);
    expect(clients[0]?.scaleViewport).toBe(true);
    expect(clients[0]?.resizeSession).toBe(false);
    const text = view.container.textContent ?? "";
    for (const word of CHROME) expect(text).not.toContain(word);
    await view.cleanup();
  });

  it("does not open another client when the sealed url is rendered again", async () => {
    const view = await renderScreen("sand", SEALED);
    await view.rerender("sand", SEALED);
    expect(clients).toHaveLength(1);
    expect(clients[0]?.disconnect).not.toHaveBeenCalled();
    await view.cleanup();
  });

  it("retries an unexpected drop once and stops, including after unmount", async () => {
    vi.useFakeTimers();
    const view = await renderScreen("sand", SEALED);
    expect(clients).toHaveLength(1);
    await act(async () => {
      clients[0]?.emitDisconnect(false);
    });
    expect(clients).toHaveLength(1);
    await act(async () => {
      vi.advanceTimersByTime(SAND_SCREEN_RETRY_MS);
      await Promise.resolve();
    });
    expect(clients).toHaveLength(2);
    await act(async () => {
      clients[1]?.emitDisconnect(false);
      vi.advanceTimersByTime(SAND_SCREEN_RETRY_MS * 5);
      await Promise.resolve();
    });
    expect(clients).toHaveLength(2);

    const beforeUnmount = clients.length;
    await view.cleanup();
    await act(async () => {
      vi.advanceTimersByTime(SAND_SCREEN_RETRY_MS * 5);
      await Promise.resolve();
    });
    expect(clients).toHaveLength(beforeUnmount);
  });

  it("lets an interactive control seal send input", async () => {
    const view = await renderScreen("sand", CONTROL, "auto");
    expect(clients[0]?.viewOnly).toBe(false);
    expect(clients[0]?.focusOnClick).toBe(true);
    expect(view.container.querySelector("iframe")).toBeNull();
    await view.cleanup();
  });

  it("fills the side-panel preview from the same 6081 display token", async () => {
    const upstream = "http://127.0.0.1:6081?token=101";
    const sealed = sealScreenCapability(
      upstream,
      "fake-secret",
      "https://app.example",
      {
        botId: "bot-a",
        computerId: "computer",
        botGeneration: 1,
        computerGeneration: 1,
        controlLeaseId: null,
      },
      100,
    );
    const page = new URL(sealed);
    expect(page.origin).toBe("https://app.example");
    expect(page.search).not.toContain("token=101");
    expect(sealed).not.toContain("14020");
    expect(sealed).not.toContain(":20");
    const socketPath = new URL(page.searchParams.get("path") ?? "", page.origin).pathname;
    expect(openScreenCapability(socketPath, "fake-secret", 101)?.target).toMatchObject({
      protocol: "http:",
      hostname: "127.0.0.1",
      port: 6081,
      path: "/websockify?token=101",
    });
    const view = await renderScreen("sand", sealed, "none");
    const frame = view.container.querySelector("[data-testid='sand-screen-frame']");
    expect(frame?.getAttribute("aria-label")).toBe("Bot screen preview");
    expect(frame?.className).toContain("absolute");
    expect(frame?.className).toContain("inset-0");
    expect(view.container.querySelector("iframe")).toBeNull();
    expect(clients).toHaveLength(1);
    expect(clients[0]?.url).toBe(sandScreenSocketUrl(sealed, window.location.href));
    expect(clients[0]?.url).not.toContain("14020");
    expect(clients[0]?.url).not.toContain(":20");
    await view.cleanup();
  });

  it("keeps private and other non-sand screens on the stock iframe", async () => {
    const docker = await renderScreen("docker", "https://screen.example/vnc.html", "auto");
    const iframe = docker.container.querySelector("iframe");
    expect(iframe?.getAttribute("src")).toBe("https://screen.example/vnc.html");
    expect(iframe?.getAttribute("title")).toBe("Bot screen");
    expect(iframe?.getAttribute("allow")).toBe("clipboard-read; clipboard-write; fullscreen");
    expect(iframe?.getAttribute("sandbox")).toBeNull();
    expect(iframe?.style.pointerEvents).toBe("auto");
    expect(clients).toHaveLength(0);
    await docker.cleanup();

    const privateComputer = await renderScreen("fake", SEALED);
    const stock = privateComputer.container.querySelector("iframe");
    expect(stock?.getAttribute("src")).toBe(SEALED);
    expect(stock?.getAttribute("title")).toBe("Bot screen preview");
    expect(stock?.getAttribute("sandbox")).toBe("allow-scripts allow-pointer-lock");
    expect(stock?.getAttribute("allow")).toBe("clipboard-read; clipboard-write");
    expect(stock?.style.pointerEvents).toBe("none");
    expect(privateComputer.container.querySelector("[data-testid='sand-screen-frame']")).toBeNull();
    expect(clients).toHaveLength(0);
    await privateComputer.cleanup();
  });
});
