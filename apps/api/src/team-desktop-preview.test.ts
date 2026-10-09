import { describe, expect, it } from "vitest";
import { toComputerStatus } from "./computer-status.js";
import { applyTeamDesktopPreview, teamDesktopPreviewState } from "./team-desktop-preview.js";

const sharedRunning = toComputerStatus("bot-1", {
  kind: "sand",
  state: "running",
  scope: "team",
  controlHolder: "none",
  homeRevision: "revision-1",
});

describe("team desktop preview", () => {
  it("drives the card from the bot's desktop when the shared computer stays running", async () => {
    expect(sharedRunning.state).toBe("running");
    expect(sharedRunning.screenAvailable).toBe(true);
    const desktops = {
      status: async () => ({
        botId: "bot-1",
        displayIndex: 101,
        state: "stopped" as const,
        lastUsedAt: null,
      }),
      member: async () => true,
    };
    const asleep = await teamDesktopPreviewState(desktops, "bot-1");
    expect(asleep).toBe("suspended");
    expect(applyTeamDesktopPreview(sharedRunning, asleep)).toMatchObject({
      state: "suspended",
      screenAvailable: false,
    });

    desktops.status = async () => ({
      botId: "bot-1",
      displayIndex: 101,
      state: "booting",
      lastUsedAt: null,
    });
    expect(
      applyTeamDesktopPreview(sharedRunning, await teamDesktopPreviewState(desktops, "bot-1")),
    ).toMatchObject({
      state: "booting",
      screenAvailable: true,
    });

    desktops.status = async () => ({
      botId: "bot-1",
      displayIndex: 101,
      state: "running",
      lastUsedAt: null,
    });
    expect(
      applyTeamDesktopPreview(sharedRunning, await teamDesktopPreviewState(desktops, "bot-1")),
    ).toBe(sharedRunning);
  });

  it("treats a member with no row as asleep and leaves everyone else on the computer row", async () => {
    const member = {
      status: async () => null,
      member: async () => true,
    };
    expect(
      applyTeamDesktopPreview(sharedRunning, await teamDesktopPreviewState(member, "bot-1")),
    ).toMatchObject({
      state: "suspended",
      screenAvailable: false,
    });
    const outsider = {
      status: async () => null,
      member: async () => false,
    };
    expect(
      applyTeamDesktopPreview(sharedRunning, await teamDesktopPreviewState(outsider, "bot-1")),
    ).toBe(sharedRunning);
    expect(
      applyTeamDesktopPreview(sharedRunning, await teamDesktopPreviewState(undefined, "bot-1")),
    ).toBe(sharedRunning);
  });

  it("keeps a maintenance boot visible over an asleep desktop", () => {
    const booting = toComputerStatus("bot-1", {
      kind: "sand",
      state: "running",
      scope: "team",
      controlHolder: "none",
      homeRevision: "revision-1",
      maintenanceId: "update-1",
    });
    expect(booting.state).toBe("booting");
    expect(applyTeamDesktopPreview(booting, "suspended", { maintenance: true })).toBe(booting);
  });
});
