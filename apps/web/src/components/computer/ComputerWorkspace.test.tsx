// @vitest-environment jsdom

import type { ComputerStatus } from "@rakazo/contracts";
import type { ComponentProps } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    String.raw({ raw: parts }, ...values);
  return { useLingui: () => ({ t }) };
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
  cn: (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(" "),
}));
vi.mock("./FilesApp", () => ({
  FilesApp: () => null,
}));
vi.mock("./TerminalApp", () => ({
  default: () => null,
}));

import { ComputerWorkspace } from "./ComputerWorkspace";

function computer(overrides: Partial<ComputerStatus> = {}): ComputerStatus {
  return {
    botId: "bot-1",
    mode: "team",
    kind: "docker",
    state: "running",
    controlHolder: "none",
    controlBotId: null,
    takeoverRequested: false,
    screenAvailable: true,
    screenWidth: 1280,
    screenHeight: 800,
    homeRevision: null,
    busyBotName: null,
    canUpdate: true,
    terminalAvailable: true,
    ...overrides,
  };
}

function labels(container: HTMLElement) {
  return [...container.querySelectorAll("button")].map((button) =>
    button.getAttribute("aria-label"),
  );
}

async function renderWorkspace(status: ComputerStatus | null, dock = true) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <ComputerWorkspace botId="bot-1" computer={status} hasControl dock={dock}>
        <div>screen</div>
      </ComputerWorkspace>,
    );
  });
  return {
    container,
    async cleanup() {
      await act(async () => root.unmount());
      container.remove();
      vi.unstubAllGlobals();
    },
  };
}

afterEach(() => {
  document.body.replaceChildren();
});

it("hides the browser, terminal, and files dock when the computer is sand", async () => {
  const view = await renderWorkspace(computer({ kind: "sand", mode: "team" }));
  expect(view.container.textContent).toContain("screen");
  expect(labels(view.container)).toEqual([]);
  await view.cleanup();
});

it("keeps the dock for other providers, including a private computer", async () => {
  const docker = await renderWorkspace(computer({ kind: "docker", mode: "team" }));
  expect(labels(docker.container)).toEqual(["Browser", "Terminal", "Files"]);
  await docker.cleanup();

  const privateComputer = await renderWorkspace(computer({ kind: "fake", mode: "dedicated" }));
  expect(labels(privateComputer.container)).toEqual(["Browser", "Terminal", "Files"]);
  await privateComputer.cleanup();
});

it("still hides the dock while teaching", async () => {
  const view = await renderWorkspace(computer({ kind: "docker" }), false);
  expect(view.container.textContent).toContain("screen");
  expect(labels(view.container)).toEqual([]);
  await view.cleanup();
});
