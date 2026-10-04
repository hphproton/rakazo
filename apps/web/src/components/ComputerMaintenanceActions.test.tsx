// @vitest-environment jsdom

import type { ComputerStatus } from "@rakazo/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("../lib/rpc", () => ({ rpc: { computer: { reset: vi.fn() } } }));
vi.mock("../lib/computer-updates", () => ({ computerUpdates: { start: vi.fn() } }));
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    String.raw({ raw: parts }, ...values);
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});
vi.mock("@rakazo/ui-web", () => ({
  Button: ({
    variant: _variant,
    size: _size,
    ...props
  }: ComponentProps<"button"> & { variant?: string; size?: string }) => <button {...props} />,
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({
    children,
    render: _render,
    ...props
  }: { children: ReactNode; render?: ReactNode } & ComponentProps<"button">) => (
    <button {...props}>{children}</button>
  ),
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AlertDialog: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AlertDialogAction: ({ children }: { children: ReactNode }) => (
    <button type="button">{children}</button>
  ),
  AlertDialogCancel: ({ children }: { children: ReactNode }) => (
    <button type="button">{children}</button>
  ),
  AlertDialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AlertDialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  AlertDialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AlertDialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AlertDialogTitle: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

import { ComputerMaintenanceActions } from "./ComputerMaintenanceActions";

function computer(overrides: Partial<ComputerStatus> = {}): ComputerStatus {
  return {
    botId: "bot-1",
    mode: "team",
    kind: "fake",
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

async function renderMenu(status: ComputerStatus | null) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <ComputerMaintenanceActions
        botId="bot-1"
        computer={status}
        onChanged={async () => undefined}
      />,
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

it("hides recover, reset, and update when the computer is sand", async () => {
  const view = await renderMenu(computer({ kind: "sand", mode: "dedicated" }));
  expect(view.container.textContent).not.toContain("Recover computer");
  expect(view.container.textContent).not.toContain("Reset computer");
  expect(view.container.textContent).not.toContain("Update computer");
  expect(view.container.querySelector("[data-testid='computer-more-button']")).toBeNull();
  await view.cleanup();
});

it("keeps recover, reset, and update for other providers, including a private computer", async () => {
  const team = await renderMenu(computer({ kind: "docker", mode: "team" }));
  expect(team.container.textContent).toContain("Recover computer");
  expect(team.container.textContent).toContain("Reset computer");
  expect(team.container.textContent).toContain("Update computer");
  await team.cleanup();

  const privateComputer = await renderMenu(computer({ kind: "fake", mode: "dedicated" }));
  expect(privateComputer.container.textContent).toContain("Recover computer");
  expect(privateComputer.container.textContent).toContain("Reset computer");
  expect(privateComputer.container.textContent).toContain("Update computer");
  await privateComputer.cleanup();
});
