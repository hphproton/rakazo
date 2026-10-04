// @vitest-environment jsdom

import type { ComputerStatus, SandboxKind } from "@rakazo/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { computerMaintenanceActions, computerWorkspaceDockVisible } from "../lib/computer-chrome";

vi.mock("../lib/rpc", () => ({
  rpc: { computer: { reset: vi.fn(), listFiles: vi.fn(), readFile: vi.fn() } },
}));
vi.mock("../lib/computer-updates", () => ({
  computerUpdates: { start: vi.fn() },
}));
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce(
      (text, part, index) => `${text}${index > 0 ? String(values[index - 1]) : ""}${part}`,
      "",
    );
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});
vi.mock("@rakazo/ui-web", () => ({
  cn: (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(" "),
  Button: ({
    variant: _variant,
    size: _size,
    ...props
  }: ComponentProps<"button"> & { variant?: string; size?: string }) => (
    <button type="button" {...props} />
  ),
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({
    children,
    render: _render,
    ...props
  }: ComponentProps<"button"> & { render?: unknown }) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({
    children,
    closeOnClick: _closeOnClick,
    ...props
  }: ComponentProps<"button"> & { closeOnClick?: boolean }) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
  AlertDialog: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AlertDialogAction: ({ children, ...props }: ComponentProps<"button">) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
  AlertDialogCancel: ({ children, ...props }: ComponentProps<"button">) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
  AlertDialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AlertDialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  AlertDialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AlertDialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AlertDialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}));

import { ComputerMaintenanceActions } from "./ComputerMaintenanceActions";
import { ComputerWorkspace } from "./computer/ComputerWorkspace";

const STOCK_KINDS = [
  "docker",
  "e2b",
  "daytona",
  "createos",
  "box",
  "desktop",
  "fake",
] as const satisfies readonly SandboxKind[];

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

let root: Root | undefined;
let host: HTMLDivElement | undefined;

function render(node: ReactNode) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root?.render(node);
  });
}

function buttonText() {
  return [...(host?.querySelectorAll("button") ?? [])].map(
    (button) => button.getAttribute("aria-label") ?? button.textContent ?? "",
  );
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
});

describe("sand computer chrome", () => {
  it("omits maintenance and the workspace dock only for kind sand", () => {
    expect(computerMaintenanceActions(computer({ kind: "sand", canUpdate: true }))).toEqual({
      recover: false,
      reset: false,
      update: false,
    });
    expect(computerWorkspaceDockVisible("sand", true)).toBe(false);
    for (const kind of STOCK_KINDS) {
      expect(computerMaintenanceActions(computer({ kind, canUpdate: true }))).toEqual({
        recover: true,
        reset: true,
        update: true,
      });
      expect(computerWorkspaceDockVisible(kind, true)).toBe(true);
    }
    expect(computerWorkspaceDockVisible("docker", false)).toBe(false);
  });

  it("hides Recover, Reset, and Update for sand, including a dedicated sand computer", () => {
    render(
      <ComputerMaintenanceActions
        botId="bot-1"
        computer={computer({ kind: "sand", mode: "dedicated", canUpdate: true })}
        onChanged={async () => undefined}
      />,
    );
    expect(buttonText().join(" ")).not.toMatch(/Recover|Reset|Update/);
  });

  it("keeps Recover, Reset, and Update for a Private computer on a stock provider", () => {
    render(
      <ComputerMaintenanceActions
        botId="bot-1"
        computer={computer({ kind: "e2b", mode: "dedicated", canUpdate: true })}
        onChanged={async () => undefined}
      />,
    );
    const labels = buttonText().join(" ");
    expect(labels).toContain("Recover computer");
    expect(labels).toContain("Reset computer");
    expect(labels).toContain("Update computer");
  });

  it("keeps the maintenance menu for docker and desktop", () => {
    render(
      <ComputerMaintenanceActions
        botId="bot-1"
        computer={computer({ kind: "docker" })}
        onChanged={async () => undefined}
      />,
    );
    expect(buttonText().join(" ")).toContain("Recover computer");

    act(() => root?.unmount());
    host?.remove();
    render(
      <ComputerMaintenanceActions
        botId="bot-1"
        computer={computer({ kind: "desktop", canUpdate: false })}
        onChanged={async () => undefined}
      />,
    );
    const labels = buttonText().join(" ");
    expect(labels).toContain("Recover computer");
    expect(labels).toContain("Reset computer");
    expect(labels).not.toContain("Update computer");
  });

  it("hides Browser, Terminal, and Files only for sand and keeps the screen", () => {
    render(
      <ComputerWorkspace
        botId="bot-1"
        computer={computer({ kind: "sand", mode: "team" })}
        hasControl={false}
        dock
      >
        <p>Screen</p>
      </ComputerWorkspace>,
    );
    expect(host?.textContent).toContain("Screen");
    expect(buttonText()).not.toContain("Browser");
    expect(buttonText()).not.toContain("Terminal");
    expect(buttonText()).not.toContain("Files");

    act(() => root?.unmount());
    host?.remove();
    render(
      <ComputerWorkspace
        botId="bot-1"
        computer={computer({ kind: "box", mode: "dedicated" })}
        hasControl={false}
        dock
      >
        <p>Screen</p>
      </ComputerWorkspace>,
    );
    expect(buttonText()).toEqual(expect.arrayContaining(["Browser", "Terminal", "Files"]));

    act(() => root?.unmount());
    host?.remove();
    render(
      <ComputerWorkspace
        botId="bot-1"
        computer={computer({ kind: "desktop", mode: "dedicated" })}
        hasControl={false}
        dock
      >
        <p>Screen</p>
      </ComputerWorkspace>,
    );
    const labels = buttonText();
    expect(labels).not.toContain("Browser");
    expect(labels).toEqual(expect.arrayContaining(["Terminal", "Files"]));
  });
});
