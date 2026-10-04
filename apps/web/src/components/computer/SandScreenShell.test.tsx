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
    variant: "overlay" | "panel";
    onOpenFull: () => void;
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
  const render = (next: typeof props) =>
    root.render(
      <SandScreenShell
        variant={next.variant ?? "overlay"}
        botName="Atlas"
        url={next.url === undefined ? sealed : next.url}
        state={next.state ?? "running"}
        screenError={next.screenError ?? false}
        screenWidth={next.screenWidth}
        screenHeight={next.screenHeight}
        fallback={<div>screen unavailable</div>}
        onClose={() => undefined}
        onOpenFull={next.onOpenFull}
      />,
    );
  return {
    container,
    async draw(next: typeof props = props) {
      await act(async () => {
        render({ ...props, ...next });
      });
    },
    async cleanup() {
      await act(async () => root.unmount());
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

function buttonNamed(container: HTMLElement, label: string) {
  return [...container.querySelectorAll("button")].find((button) => button.textContent === label);
}

it("shows the bot name and connects the sealed websocket without vnc.html", async () => {
  const view = renderShell();
  await view.draw();
  expect(view.container.textContent).toContain("Atlas");
  expect(view.container.textContent).toContain("Reconnecting");
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
  const frame = view.container.querySelector("[data-testid=sand-screen-frame]");
  expect(frame?.getAttribute("style")).toContain("width: 1000px");
  expect(frame?.getAttribute("style")).toContain("height: 625px");
  await act(async () => {
    client?.dispatchEvent(new Event("connect"));
  });
  expect(view.container.textContent).toContain("Connected");
  await view.cleanup();
});

it("sizes the sidebar picture as a 16/10 card and fills it for a 1280×800 seat", async () => {
  observed = { width: 1600, height: 1000 };
  const view = renderShell({ variant: "panel", screenWidth: 1280, screenHeight: 800 });
  await view.draw();
  const shell = view.container.querySelector("[data-testid=sand-screen-shell]");
  const viewport = view.container.querySelector("[data-testid=sand-screen-viewport]");
  const frame = view.container.querySelector("[data-testid=sand-screen-frame]");
  expect(shell?.className).not.toContain("70vh");
  expect(shell?.className).not.toContain("min-h-80");
  expect(viewport?.className).toContain("aspect-[16/10]");
  expect(viewport?.className).not.toContain("flex-1");
  expect(frame?.getAttribute("style")).toContain("width: 1600px");
  expect(frame?.getAttribute("style")).toContain("height: 1000px");
  await view.cleanup();
});

it("letterboxes inside the 16/10 card only when the bitmap aspect differs", async () => {
  observed = { width: 1600, height: 1000 };
  const view = renderShell({ variant: "panel", screenWidth: 1280, screenHeight: 720 });
  await view.draw();
  const viewport = view.container.querySelector("[data-testid=sand-screen-viewport]");
  const frame = view.container.querySelector("[data-testid=sand-screen-frame]");
  expect(viewport?.className).toContain("aspect-[16/10]");
  expect(frame?.getAttribute("style")).toContain("width: 1600px");
  expect(frame?.getAttribute("style")).toContain("height: 900px");
  await view.cleanup();
});

it("opens the in-app RFB viewer instead of a vnc.html tab", async () => {
  const open = vi.fn();
  const onOpenFull = vi.fn();
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("open", open);
  Object.assign(navigator, { clipboard: { writeText } });
  const view = renderShell({ variant: "panel", onOpenFull });
  await view.draw();
  await act(async () => {
    buttonNamed(view.container, "Open full")?.click();
    buttonNamed(view.container, "Copy link")?.click();
  });
  expect(onOpenFull).toHaveBeenCalledOnce();
  expect(open).not.toHaveBeenCalled();
  expect(writeText).toHaveBeenCalledWith(sealed);
  expect(view.container.querySelector("iframe")).toBeNull();
  expect(view.container.textContent).not.toContain("vnc.html");
  expect(FakeRFB.created.at(-1)?.url).toBe(
    `ws://127.0.0.1:5173/novnc/session/view/${now + 120_000}.same-token/websockify`,
  );

  await view.draw({ variant: "overlay" });
  const fullViewport = view.container.querySelector("[data-testid=sand-screen-viewport]");
  expect(open).not.toHaveBeenCalled();
  expect(fullViewport?.className).toContain("flex-1");
  expect(fullViewport?.className).not.toContain("aspect-[16/10]");
  expect(view.container.querySelector("[data-testid=sand-screen-open-full]")).toBeNull();
  expect(view.container.querySelector("iframe")).toBeNull();
  expect(view.container.textContent).toContain("Copy link");
  expect(view.container.textContent).toContain("Reconnecting");
  expect(view.container.textContent).not.toContain("vnc.html");
  expect(view.container.textContent).not.toContain("Clipboard");
  expect(view.container.textContent).not.toContain("noVNC");
  expect(view.container.querySelector("[data-testid=sand-screen-frame]")).not.toBeNull();
  expect(FakeRFB.created.at(-1)?.url).not.toContain("vnc.html");
  await view.cleanup();
});

it("keeps the panel shell free of a second close control", async () => {
  const view = renderShell({ variant: "panel" });
  await view.draw();
  expect(view.container.textContent).toContain("Open full");
  expect(view.container.textContent).not.toContain("Close computer");
  await view.cleanup();
});

it("marks a stopped sand screen stale and hides the iframe", async () => {
  const view = renderShell({ state: "stopped" });
  await view.draw();
  expect(view.container.textContent).toContain("Stale");
  expect(view.container.querySelector("iframe")).toBeNull();
  expect(view.container.querySelector("[data-testid=sand-screen-frame]")).toBeNull();
  expect(FakeRFB.created).toHaveLength(0);
  expect(view.container.textContent).toContain("screen unavailable");
  await view.cleanup();
});
