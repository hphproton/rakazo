import { BOT_COLORS } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { groupBotsForSidebar } from "./bot-sections.js";
import {
  buildHubDirectory,
  DEPRECATED_HUB_INBOUND_PROCEDURES,
  HUB_INBOUND_PROCEDURE,
  HUB_MIRROR_NOT_A_CHAT,
  HUB_SECTION_NAME,
  HubRosterError,
  type HubRosterRecord,
  hubAgentIdFromSpawnKey,
  hubInboundCall,
  hubInboundCutover,
  hubMirrorChatRefusal,
  hubRosterColor,
  hubRosterEpoch,
  hubSpawnKey,
  isHubInboundEnvelope,
  planHubRosterSync,
  RAKAZO_TO_HUB_PATH,
  VISIBLE_ROSTER_BOT_WHERE,
} from "./hub-directory.js";

function bot(overrides: Partial<HubRosterRecord> & Pick<HubRosterRecord, "id">): HubRosterRecord {
  return {
    name: overrides.name ?? "Bot",
    title: overrides.title ?? "",
    archived: overrides.archived ?? false,
    spawnKey: overrides.spawnKey ?? null,
    sectionId: overrides.sectionId ?? null,
    updatedAt: overrides.updatedAt ?? "2026-10-01T00:00:00.000Z",
    id: overrides.id,
  };
}

describe("hub roster identity", () => {
  it("round-trips a Hub agent id through the reserved spawn key", () => {
    expect(hubSpawnKey("hub-atlas")).toBe("hub:hub-atlas");
    expect(hubAgentIdFromSpawnKey("hub:hub-atlas")).toBe("hub-atlas");
    expect(hubAgentIdFromSpawnKey("onboarding:first")).toBeNull();
    expect(hubAgentIdFromSpawnKey("hub:")).toBeNull();
    expect(() => hubSpawnKey("  ")).toThrow(HubRosterError);
  });

  it("picks a color from the existing bot palette", () => {
    expect(BOT_COLORS).toContain(hubRosterColor("hub-atlas"));
    expect(hubRosterColor("hub-atlas")).toBe(hubRosterColor("hub-atlas"));
  });

  it("keeps Hub roster rows out of the member list without dropping other bots", () => {
    expect(VISIBLE_ROSTER_BOT_WHERE).toEqual({
      OR: [{ spawnKey: null }, { NOT: { spawnKey: { startsWith: "hub:" } } }],
    });
    expect(hubMirrorChatRefusal("hub:box-principal")).toBe(HUB_MIRROR_NOT_A_CHAT);
    expect(hubMirrorChatRefusal("onboarding:first")).toBeUndefined();
    expect(hubMirrorChatRefusal(null)).toBeUndefined();
  });
});

describe("planHubRosterSync", () => {
  const sectionId = "section-hub";

  it("creates Hub rows, archives members that left, and leaves workspace bots", () => {
    const plan = planHubRosterSync(
      [
        bot({ id: "chief", name: "Chief", spawnKey: "onboarding:first" }),
        bot({ id: "atlas", name: "Atlas", spawnKey: "hub:hub-atlas", sectionId }),
        bot({ id: "nova", name: "Nova", spawnKey: "hub:hub-nova", sectionId }),
      ],
      [
        { hubAgentId: "hub-atlas", name: "Atlas Prime", title: "Deploy" },
        { hubAgentId: "hub-quill", name: "Quill" },
      ],
      sectionId,
    );

    expect(plan.create).toEqual([
      {
        hubAgentId: "hub-quill",
        spawnKey: "hub:hub-quill",
        name: "Quill",
        title: "",
      },
    ]);
    expect(plan.update).toEqual([
      {
        botId: "atlas",
        hubAgentId: "hub-atlas",
        name: "Atlas Prime",
        title: "Deploy",
        unarchive: false,
      },
    ]);
    expect(plan.archive).toEqual([{ botId: "nova", hubAgentId: "hub-nova" }]);
  });

  it("keeps the same bot id when an archived member returns", () => {
    const plan = planHubRosterSync(
      [
        bot({
          id: "atlas",
          name: "Atlas",
          spawnKey: "hub:hub-atlas",
          archived: true,
          sectionId: null,
        }),
      ],
      [{ hubAgentId: "hub-atlas", name: "Atlas" }],
      sectionId,
    );
    expect(plan.create).toEqual([]);
    expect(plan.archive).toEqual([]);
    expect(plan.update).toEqual([
      {
        botId: "atlas",
        hubAgentId: "hub-atlas",
        name: "Atlas",
        title: "",
        unarchive: true,
      },
    ]);
  });

  it("is a no-op when the snapshot already matches", () => {
    const plan = planHubRosterSync(
      [bot({ id: "atlas", name: "Atlas", title: "Deploy", spawnKey: "hub:hub-atlas", sectionId })],
      [{ hubAgentId: "hub-atlas", name: "Atlas", title: "Deploy" }],
      sectionId,
    );
    expect(plan).toEqual({ create: [], update: [], archive: [] });
  });

  it("rejects a duplicate Hub agent id", () => {
    expect(() =>
      planHubRosterSync(
        [],
        [
          { hubAgentId: "hub-atlas", name: "Atlas" },
          { hubAgentId: "hub-atlas", name: "Other" },
        ],
        sectionId,
      ),
    ).toThrow(/Duplicate Hub agent id hub-atlas/);
  });
});

describe("buildHubDirectory", () => {
  it("splits Hub members from workspace bots and keeps a stable epoch", () => {
    const bots = [
      bot({ id: "chief", name: "Chief", title: "Lead", spawnKey: "onboarding:first" }),
      bot({
        id: "atlas",
        name: "Atlas",
        title: "Deploy",
        spawnKey: "hub:hub-atlas",
        sectionId: "section-hub",
      }),
    ];
    const first = buildHubDirectory({
      spaceId: "space-1",
      bots,
      issuedAt: "2026-10-02T00:00:00.000Z",
    });
    const second = buildHubDirectory({
      spaceId: "space-1",
      bots,
      issuedAt: "2026-10-02T00:05:00.000Z",
    });

    expect(first.hubMembers).toEqual([
      {
        hubAgentId: "hub-atlas",
        botId: "atlas",
        name: "Atlas",
        title: "Deploy",
        archived: false,
      },
    ]);
    expect(first.rakazoBots).toEqual([
      {
        id: "chief",
        name: "Chief",
        title: "Lead",
        archived: false,
        spawnKey: "onboarding:first",
      },
    ]);
    expect(first.epoch).toBe(second.epoch);
    expect(first.epoch).toBe(hubRosterEpoch(first.spaceId, first.hubMembers, first.rakazoBots));
    expect(second.issuedAt).not.toBe(first.issuedAt);

    const renamed = buildHubDirectory({
      spaceId: "space-1",
      bots: bots.map((item) => (item.id === "atlas" ? { ...item, name: "Atlas Prime" } : item)),
      issuedAt: first.issuedAt,
    });
    expect(renamed.epoch).not.toBe(first.epoch);
    expect(first.groups).toEqual([]);
  });

  it("exports workspace group members and changes the epoch when membership changes", () => {
    const bots = [
      bot({ id: "chief", name: "Chief", spawnKey: null }),
      bot({ id: "deputy", name: "Deputy", spawnKey: null, archived: true }),
      bot({ id: "atlas", name: "Atlas", spawnKey: "hub:hub-atlas" }),
    ];
    const groups = [
      {
        id: "group-b",
        name: "Team B",
        archived: false,
        memberBotIds: ["atlas", "deputy", "chief", "chief", "missing"],
      },
      {
        id: "group-a",
        name: "Archived",
        archived: true,
        memberBotIds: ["chief"],
      },
      {
        id: "group-hub",
        name: "Hub only",
        archived: false,
        memberBotIds: ["atlas"],
      },
    ];
    const first = buildHubDirectory({
      spaceId: "space-1",
      bots,
      groups,
      issuedAt: "2026-10-02T00:00:00.000Z",
    });
    expect(first.groups).toEqual([
      { id: "group-b", name: "Team B", memberBotIds: ["chief"] },
      { id: "group-hub", name: "Hub only", memberBotIds: [] },
    ]);
    expect(first.epoch).toBe(
      hubRosterEpoch(first.spaceId, first.hubMembers, first.rakazoBots, first.groups),
    );
    const same = buildHubDirectory({
      spaceId: "space-1",
      bots,
      groups,
      issuedAt: "2026-10-02T00:05:00.000Z",
    });
    expect(same.epoch).toBe(first.epoch);

    const joined = buildHubDirectory({
      spaceId: "space-1",
      bots: bots.map((item) => (item.id === "deputy" ? { ...item, archived: false } : item)),
      groups,
      issuedAt: first.issuedAt,
    });
    expect(joined.groups).toEqual([
      { id: "group-b", name: "Team B", memberBotIds: ["chief", "deputy"] },
      { id: "group-hub", name: "Hub only", memberBotIds: [] },
    ]);
    expect(joined.epoch).not.toBe(first.epoch);
  });

  it("places mirrored rows in the Hub section of the shared roster grouper", () => {
    const groups = groupBotsForSidebar(
      [
        { id: "chief", pinned: false, sectionId: null },
        { id: "atlas", pinned: false, sectionId: "section-hub" },
      ],
      [{ id: "section-hub", name: HUB_SECTION_NAME }],
    );
    expect(groups.map((group) => [group.title, group.bots.map((item) => item.id)])).toEqual([
      [HUB_SECTION_NAME, ["atlas"]],
      ["Unassigned", ["chief"]],
    ]);
  });
});

describe("hub inbound cutover", () => {
  it("prefers threads/receiveHub and keeps Rakazo to Hub on MCP", () => {
    expect(
      hubInboundCall({
        botId: "bot-1",
        hubAgentId: "hub-atlas",
        hubAgentName: "Atlas",
        text: "Deploy",
      }),
    ).toEqual({
      procedure: HUB_INBOUND_PROCEDURE,
      input: {
        botId: "bot-1",
        hubAgentId: "hub-atlas",
        hubAgentName: "Atlas",
        text: "Deploy",
      },
    });
    expect(hubInboundCutover(HUB_INBOUND_PROCEDURE)).toEqual({
      procedure: HUB_INBOUND_PROCEDURE,
      rakazoToHub: RAKAZO_TO_HUB_PATH,
      deprecated: false,
    });
    for (const procedure of DEPRECATED_HUB_INBOUND_PROCEDURES) {
      expect(hubInboundCutover(procedure).deprecated).toBe(true);
      expect(hubInboundCutover(procedure).procedure).toBe(HUB_INBOUND_PROCEDURE);
      expect(hubInboundCutover(procedure).rakazoToHub).toBe("mcp");
    }
  });

  it("recognizes a Hub envelope and ignores an ordinary webhook body", () => {
    expect(isHubInboundEnvelope({ origin: "hub", text: "hi" })).toBe(true);
    expect(isHubInboundEnvelope({ event: "hub_message" })).toBe(true);
    expect(
      isHubInboundEnvelope({ hubAgentId: "hub-atlas", hubAgentName: "Atlas", text: "hi" }),
    ).toBe(true);
    expect(isHubInboundEnvelope({ event: "github.push", ref: "main" })).toBe(false);
    expect(isHubInboundEnvelope({ text: "hello" })).toBe(false);
    expect(isHubInboundEnvelope({ hubAgentId: "hub-atlas" })).toBe(false);
  });
});
