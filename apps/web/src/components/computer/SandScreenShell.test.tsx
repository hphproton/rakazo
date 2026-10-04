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

class BoxObserver {
  constructor(private callback: ResizeObserverCallback) {}
  observe() {
    this.callback(
      [
        {
          contentRect: { width: 1000, height: 1000 },
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
  }> = {},
) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  vi.setSystemTime(now);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  return {
    container,
    async draw() {
      await act(async () => {
        root.render(
          <SandScreenShell
            variant={props.variant ?? "overlay"}
            botName="Atlas"
            url={props.url === undefined ? sealed : props.url}
            state={props.state ?? "running"}
            screenError={props.screenError ?? false}
            fallback={<div>screen unavailable</div>}
            onClose={() => undefined}
          />,
        );
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
});

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

it("opens and copies the sealed url without using it as the picture", async () => {
  const open = vi.fn();
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("open", open);
  Object.assign(navigator, { clipboard: { writeText } });
  const view = renderShell();
  await view.draw();
  const openFull = [...view.container.querySelectorAll("button")].find(
    (button) => button.textContent === "Open full",
  );
  const copy = [...view.container.querySelectorAll("button")].find(
    (button) => button.textContent === "Copy link",
  );
  await act(async () => {
    openFull?.click();
    copy?.click();
  });
  expect(open).toHaveBeenCalledWith(sealed, "_blank", "noopener,noreferrer");
  expect(writeText).toHaveBeenCalledWith(sealed);
  expect(view.container.querySelector("iframe")).toBeNull();
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
