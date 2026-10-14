import { describe, expect, it } from "vitest";
import { computerScreenUrlInput } from "./computer-screen.js";

describe("computerScreenUrlInput", () => {
  it("asks the preview for a view seal and the overlay for control", () => {
    expect(computerScreenUrlInput("bot-1", "card")).toEqual({
      botId: "bot-1",
      interactive: false,
    });
    expect(computerScreenUrlInput("bot-1", "overlay")).toEqual({ botId: "bot-1" });
  });
});
