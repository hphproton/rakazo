// @vitest-environment jsdom

import type { ComputerStatus } from "@rakazo/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    String.raw({ raw: parts }, ...values);
  return {
    useLingui: () => ({ t }),
    Trans: ({ children }: { children: ReactNode }) => children,
  };
});
vi.mock("@rakazo/ui-web", () => ({
  Button: ({
    children,
    variant: _variant,
    size: _size,
    ...props
  }: ComponentProps<"button"> & { variant?: string; size?: string }) => (
    <button {...props}>{children}</button>
  ),
}));

class FakeRFB extends EventTarget {
  static created: FakeRFB[] = [];
  viewOnly = false;
  scaleViewport = false;
  resizeSession = true;
  background = "";
  constructor(
    public target: HTMLElement,
    public url: string,
    public options?: { shared?: boolean },
  ) {
    super();
    FakeRFB.created.push(this);
  }
  disconnect() {
    this.dispatchEvent(new CustomEvent("disconnect", { detail: { clean: true } }));
  }
}

vi.mock("@novnc/novnc", () => ({ default: FakeRFB }));

let observed = { width: 1000, height: 1000 };

class BoxObserver {
  constructor(private callback: ResizeObserverCallback) {}
  observe() {
    this.callback(
      [
        {
          contentRect: { ...observed },
        } as ResizeObserverEntry,
      ],
      this as unknown as ResizeObserver,
    );
  }
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", BoxObserver);

import { SandScreenShell } from "./SandScreenShell";

const now = 1_700_000_000_000;
const sealed = `http://127.0.0.1:5173/novnc/session/view/${now + 120_000}.same-token/vnc.html?autoconnect=true&path=%2Fnovnc%2Fsession%2Fview%2F${now + 120_000}.same-token%2Fwebsockify`;

function renderShell(
  props: Partial<{
    url: string | null;
    state: ComputerStatus["state"];
    screenError: boolean;
    onClose: () => void;
    screenWidth: number;
    screenHeight: number;
  }> = {},
) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", BoxObserver);
  vi.useFakeTimers();
  vi.setSystemTime(now);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let mounted = true;
  const render = (next: typeof props) =>
    root.render(
      <SandScreenShell
        botName="Atlas"
        url={next.url === undefined ? sealed : next.url}
        state={next.state ?? "running"}
        screenError={next.screenError ?? false}
        screenWidth={next.screenWidth}
        screenHeight={next.screenHeight}
        fallback={<div>screen unavailable</div>}
        onClose={next.onClose}
      />,
    );
  return {
    container,
    async draw(next: typeof props = props) {
      await act(async () => {
        render({ ...props, ...next });
      });
    },
    async unmount() {
      if (!mounted) return;
      mounted = false;
      await act(async () => root.unmount());
    },
    async cleanup() {
      if (mounted) {
        mounted = false;
        await act(async () => root.unmount());
      }
      container.remove();
      vi.useRealTimers();
      vi.unstubAllGlobals();
    },
  };
}

afterEach(() => {
  document.body.replaceChildren();
  FakeRFB.created.length = 0;
  observed = { width: 1000, height: 1000 };
});

it("connects the sealed websocket in the overlay without vnc.html or a tab", async () => {
  const open = vi.fn();
  vi.stubGlobal("open", open);
  const view = renderShell();
  await view.draw();
  expect(view.container.textContent).toContain("Atlas");
  expect(view.container.textContent).toContain("Reconnecting");
  expect(view.container.textContent).not.toMatch(/idle/i);
  expect(view.container.textContent).not.toContain("Open full");
  expect(view.container.textContent).not.toContain("Copy link");
  expect(view.container.querySelector("iframe")).toBeNull();
  expect(view.container.textContent).not.toContain("vnc.html");
  expect(view.container.textContent).not.toContain("Recover computer");
  expect(view.container.textContent).not.toContain("Terminal");
  expect(view.container.textContent).not.toContain("You have control");
  const client = FakeRFB.created.at(-1);
  expect(client?.url).toBe(
    `ws://127.0.0.1:5173/novnc/session/view/${now + 120_000}.same-token/websockify`,
  );
  expect(client?.options).toEqual({ shared: true });
  expect(client?.viewOnly).toBe(true);
  expect(client?.scaleViewport).toBe(true);
  expect(client?.resizeSession).toBe(false);
  const viewport = view.container.querySelector("[data-testid=sand-screen-viewport]");
  expect(viewport?.className).toContain("flex-1");
  expect(viewport?.className).not.toContain("aspect-[16/10]");
  expect(open).not.toHaveBeenCalled();
  const frame = view.container.querySelector("[data-testid=sand-screen-frame]");
  expect(frame?.getAttribute("style")).toContain("width: 1000px");
  expect(frame?.getAttribute("style")).toContain("height: 625px");
  await act(async () => {
    client?.dispatchEvent(new Event("connect"));
  });
  expect(view.container.textContent).toContain("Connected");
  expect(view.container.textContent).not.toMatch(/idle/i);
  await view.cleanup();
});

it("fills a 16/10 stage for a 1280×800 seat and letterboxes a different bitmap", async () => {
  observed = { width: 1600, height: 1000 };
  const filled = renderShell({ screenWidth: 1280, screenHeight: 800 });
  await filled.draw();
  const filledFrame = filled.container.querySelector("[data-testid=sand-screen-frame]");
  expect(
    filled.container.querySelector("[data-testid=sand-screen-shell]")?.className,
  ).not.toContain("70vh");
  expect(filledFrame?.getAttribute("style")).toContain("width: 1600px");
  expect(filledFrame?.getAttribute("style")).toContain("height: 1000px");
  await filled.cleanup();

  observed = { width: 1600, height: 1000 };
  const letterboxed = renderShell({ screenWidth: 1280, screenHeight: 720 });
  await letterboxed.draw();
  const frame = letterboxed.container.querySelector("[data-testid=sand-screen-frame]");
  expect(frame?.getAttribute("style")).toContain("width: 1600px");
  expect(frame?.getAttribute("style")).toContain("height: 900px");
  await letterboxed.cleanup();
});

it("disconnects on close and does not keep the reconnect loop", async () => {
  const onClose = vi.fn();
  const view = renderShell({ onClose });
  await view.draw();
  expect(FakeRFB.created).toHaveLength(1);
  const close = view.container.querySelector("[aria-label='Close computer']");
  await act(async () => {
    close?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  expect(onClose).toHaveBeenCalledOnce();

  await act(async () => {
    FakeRFB.created[0]?.dispatchEvent(new Event("disconnect"));
  });
  await view.unmount();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5_000);
  });
  expect(FakeRFB.created).toHaveLength(1);
  await view.cleanup();
});

it("reconnects while the overlay stays open", async () => {
  const view = renderShell();
  await view.draw();
  await act(async () => {
    FakeRFB.created[0]?.dispatchEvent(new Event("disconnect"));
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_000);
  });
  expect(FakeRFB.created).toHaveLength(2);
  expect(FakeRFB.created[1]?.url).not.toContain("vnc.html");
  await view.cleanup();
});

it("marks a stopped sand screen stale and does not connect", async () => {
  const view = renderShell({ state: "stopped" });
  await view.draw();
  expect(view.container.textContent).toContain("Stale");
  expect(view.container.textContent).not.toMatch(/idle/i);
  expect(view.container.querySelector("iframe")).toBeNull();
  expect(view.container.querySelector("[data-testid=sand-screen-frame]")).toBeNull();
  expect(FakeRFB.created).toHaveLength(0);
  expect(view.container.textContent).toContain("screen unavailable");
  await view.cleanup();
});
