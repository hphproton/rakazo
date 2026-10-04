import type { ComputerStatus } from "@rakazo/contracts";

/** Sand is an existing exec-daemon, not a replaceable desktop image. */
export function sandComputerKind(kind: string | undefined): boolean {
  return kind === "sand";
}

export function computerMaintenanceActions(
  computer: Pick<ComputerStatus, "kind" | "state" | "canUpdate">,
): { recover: boolean; reset: boolean; update: boolean } {
  if (sandComputerKind(computer.kind)) return { recover: false, reset: false, update: false };
  const open =
    computer.state === "error" ||
    computer.state === "running" ||
    computer.state === "suspended" ||
    computer.state === "stopped";
  return { recover: open, reset: open, update: computer.canUpdate };
}

/** Browser, Terminal, and Files sit on the dock. Sand has no shell gateway for them. */
export function computerWorkspaceDockVisible(kind: string | undefined, dock: boolean): boolean {
  return dock && !sandComputerKind(kind);
}
