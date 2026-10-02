import { describe, expect, it } from "vitest";
import { activityNotificationsEnabled, activityPromptSnippet } from "./runs.js";

describe("run activity copy", () => {
  it("presents structured agent messages instead of their internal wake prompt", () => {
    expect(
      activityPromptSnippet({
        trigger: "bot_message",
        prompt: "[bot] A message just arrived from another bot with internal routing data",
        sourceBlocks: [
          {
            kind: "bot_message_received",
            fromBotId: "maya",
            fromBotName: "Maya",
            text: "Please check the release workflow.",
            intent: "request",
          },
        ],
      }),
    ).toBe("Maya asked: Please check the release workflow.");
  });

  it("labels a Hub delivery with the Hub agent instead of the wake prompt", () => {
    expect(
      activityPromptSnippet({
        trigger: "hub_message",
        prompt: "[hub] internal wake prompt with routing data",
        sourceBlocks: [
          {
            kind: "bot_message_received",
            fromBotId: "hub-atlas",
            fromBotName: "Atlas",
            origin: "hub",
            text: "Check the deploy.",
            intent: "request",
          },
        ],
      }),
    ).toBe("Hub · Atlas asked: Check the deploy.");
  });

  it("fails closed when an agent message has no valid structured source", () => {
    expect(
      activityPromptSnippet({
        trigger: "bot_message",
        prompt: "[bot] private internal routing envelope",
        sourceBlocks: [{ kind: "text", text: "not a peer message" }],
      }),
    ).toBe("Message from another agent");
  });
});

describe("run activity notification preference", () => {
  it("silences only direct messages", () => {
    expect(activityNotificationsEnabled(null, false)).toBe(false);
    expect(activityNotificationsEnabled("group-1", false)).toBe(true);
  });
});
