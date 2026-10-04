// @vitest-environment jsdom

import type { ComputerStatus } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw(strings, ...values),
}));
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    String.raw({ raw: parts }, ...values);
  return {
    useLingui: () => ({ t }),
    Trans: ({ children }: { children: ReactNode }) => children,
  };
});

class FakeRFB extends EventTarget {
  static created: FakeRFB[] = [];
  constructor(
    public target: HTMLElement,
    public url: string,
  ) {
    super();
    FakeRFB.created.push(this);
  }
  disconnect() {}
}

vi.mock("@novnc/novnc", () => ({ default: FakeRFB }));

import { SandPreviewCard } from "./SandPreviewCard";

function renderCard(
  props: Partial<{
    open: boolean;
    state: ComputerStatus["state"];
    booting: boolean;
    label: string;
    screenError: ReactNode;
    onOpen: () => void;
  }> = {},
) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const onOpen = props.onOpen ?? vi.fn();
  act(() => {
    root.render(
      <SandPreviewCard
        open={props.open ?? false}
        state={props.state ?? "running"}
        booting={props.booting ?? false}
        label={props.label ?? "Atlas’s computer"}
        caption="Atlas's screen"
        screenError={props.screenError ?? null}
        onOpen={onOpen}
      />,
    );
  });
  return {
    container,
    onOpen,
    cleanup() {
      act(() => root.unmount());
      container.remove();
    },
  };
}

afterEach(() => {
  document.body.replaceChildren();
  FakeRFB.created.length = 0;
  vi.unstubAllGlobals();
});

it("shows a running seat as a 16/10 card without a stream or an off-machine label", () => {
  const view = renderCard();
  const card = view.container.querySelector("[data-testid=computer-preview]");
  expect(card?.className).toContain("aspect-[16/10]");
  expect(card?.className).not.toContain("70vh");
  expect(card?.className).not.toContain("min-h-80");
  expect(view.container.textContent).toContain("Atlas’s computer");
  expect(view.container.textContent).toContain("Atlas's screen");
  expect(view.container.textContent).not.toMatch(/idle/i);
  expect(view.container.textContent).not.toContain("Computer is stopped");
  expect(view.container.textContent).not.toContain("Connected");
  expect(view.container.textContent).not.toContain("Reconnecting");
  expect(view.container.textContent).not.toContain("Stale");
  expect(view.container.textContent).not.toContain("Open full");
  expect(view.container.textContent).not.toContain("Copy link");
  expect(view.container.querySelector("iframe")).toBeNull();
  expect(view.container.querySelector("[data-testid=sand-screen-frame]")).toBeNull();
  expect(view.container.textContent).not.toContain("vnc.html");
  expect(view.container.textContent).not.toContain("websockify");
  expect(FakeRFB.created).toHaveLength(0);
  view.cleanup();
});

it("opens the overlay path from a click and does not open a tab or connect RFB", () => {
  const open = vi.fn();
  vi.stubGlobal("open", open);
  const onOpen = vi.fn();
  const view = renderCard({ onOpen });
  const button = view.container.querySelector("[data-testid=computer-preview-open]");
  expect(button).not.toBeNull();
  act(() => {
    button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  expect(onOpen).toHaveBeenCalledOnce();
  expect(open).not.toHaveBeenCalled();
  expect(FakeRFB.created).toHaveLength(0);
  expect(view.container.querySelector("iframe")).toBeNull();
  view.cleanup();
});

it("says the seat is stopped only when the computer is stopped", () => {
  const running = renderCard({ state: "running" });
  expect(running.container.textContent).not.toContain("Computer is stopped");
  running.cleanup();

  const stopped = renderCard({ state: "stopped" });
  expect(stopped.container.textContent).toContain("Computer is stopped");
  expect(stopped.container.textContent).not.toMatch(/idle/i);
  expect(FakeRFB.created).toHaveLength(0);
  stopped.cleanup();
});

it("keeps the open control off the card when the screen failed", () => {
  const view = renderCard({ screenError: <div>Could not connect to the computer screen</div> });
  expect(view.container.querySelector("[data-testid=computer-preview-open]")).toBeNull();
  expect(view.container.textContent).toContain("Could not connect to the computer screen");
  expect(view.container.textContent).not.toMatch(/idle/i);
  expect(FakeRFB.created).toHaveLength(0);
  view.cleanup();
});

it("shows the stock full-window note while the overlay is open and still does not connect", () => {
  const view = renderCard({ open: true });
  expect(view.container.textContent).toContain("Open in full window");
  expect(view.container.querySelector("[data-testid=computer-preview]")?.className).toContain(
    "aspect-[16/10]",
  );
  expect(view.container.textContent).not.toMatch(/idle/i);
  expect(view.container.textContent).not.toContain("Open full");
  expect(view.container.textContent).not.toContain("Copy link");
  expect(FakeRFB.created).toHaveLength(0);
  view.cleanup();
});
