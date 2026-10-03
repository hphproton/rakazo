import { describe, expect, it } from "vitest";
import { HubDirectorySchema, HubSyncMembersInput, HubSyncResultSchema } from "./hub-directory.js";

describe("hub directory contract", () => {
  it("parses a bidirectional roster document", () => {
    const parsed = HubDirectorySchema.parse({
      epoch: "abc123",
      issuedAt: "2026-10-02T00:00:00.000Z",
      spaceId: "space-1",
      hubMembers: [
        {
          hubAgentId: "hub-atlas",
          botId: "bot-atlas",
          name: "Atlas",
          title: "Deploy",
          archived: false,
        },
      ],
      rakazoBots: [
        {
          id: "bot-chief",
          name: "Chief",
          title: "",
          archived: false,
          spawnKey: "onboarding:first",
        },
      ],
      signature: null,
    });
    expect(parsed.hubMembers[0]?.hubAgentId).toBe("hub-atlas");
    expect(parsed.groups).toEqual([]);
    expect(parsed.signature).toBeNull();
  });

  it("keeps the workspace bot export to id, name, title, archived, and spawnKey", () => {
    const parsed = HubDirectorySchema.parse({
      epoch: "abc123",
      issuedAt: "2026-10-02T00:00:00.000Z",
      spaceId: "space-1",
      hubMembers: [],
      rakazoBots: [
        {
          id: "bot-chief",
          name: "Chief",
          title: "",
          archived: false,
          spawnKey: null,
        },
      ],
      signature: null,
    });
    expect(Object.keys(parsed.rakazoBots[0] ?? {}).sort()).toEqual([
      "archived",
      "id",
      "name",
      "spawnKey",
      "title",
    ]);
    expect(parsed.groups).toEqual([]);
  });

  it("parses chat groups beside the bot export", () => {
    const parsed = HubDirectorySchema.parse({
      epoch: "abc123",
      issuedAt: "2026-10-02T00:00:00.000Z",
      spaceId: "space-1",
      hubMembers: [],
      rakazoBots: [],
      groups: [{ id: "group-team", name: "Team B", memberBotIds: ["bot-chief", "bot-deputy"] }],
      signature: null,
    });
    expect(parsed.groups).toEqual([
      { id: "group-team", name: "Team B", memberBotIds: ["bot-chief", "bot-deputy"] },
    ]);
  });

  it("accepts an empty Hub snapshot and a sync result", () => {
    expect(HubSyncMembersInput.parse({ members: [] })).toEqual({ members: [] });
    expect(
      HubSyncResultSchema.parse({
        sectionId: "section-hub",
        sectionName: "Hub",
        created: 0,
        updated: 0,
        archived: 0,
        directory: {
          epoch: "abc123",
          issuedAt: "2026-10-02T00:00:00.000Z",
          spaceId: "space-1",
          hubMembers: [],
          rakazoBots: [],
          signature: "ab".repeat(32),
        },
      }).sectionName,
    ).toBe("Hub");
  });
});
