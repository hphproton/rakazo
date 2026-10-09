import type { TeamDesktopAllocator } from "@rakazo/adapters";
import { teamDesktopCardState } from "@rakazo/adapters";
import type { ComputerStatus } from "@rakazo/contracts";

export type TeamDesktopPreview = "suspended" | "booting" | "running";

/**
 * Card state for this bot's team desktop.
 * Null means this bot is not on the team-desktop allocator (dedicated computer,
 * another provider, or a non-member). A member with no row is asleep.
 */
export async function teamDesktopPreviewState(
  desktops: Pick<TeamDesktopAllocator, "status" | "member"> | undefined,
  botId: string,
): Promise<TeamDesktopPreview | null> {
  if (!desktops) return null;
  const row = await desktops.status(botId);
  if (!row) {
    if (!(await desktops.member(botId))) return null;
    return "suspended";
  }
  return teamDesktopCardState(row.state);
}

/**
 * The shared Team computer row stays running while one bot's window is asleep.
 * The card uses the per-bot row, including stock's suspended state.
 * Maintenance still wins so an update stays visible.
 */
export function applyTeamDesktopPreview(
  status: ComputerStatus,
  preview: TeamDesktopPreview | null,
  options?: { maintenance?: boolean },
): ComputerStatus {
  if (options?.maintenance || preview == null) return status;
  const screenAvailable = preview === "running" || preview === "booting";
  if (status.state === preview && status.screenAvailable === screenAvailable) return status;
  return { ...status, state: preview, screenAvailable };
}
