import { describe, expect, it } from "vitest";
import {
  clearComputerWakeError,
  rememberComputerWakeError,
  visibleComputerWakeError,
} from "./computer-wake-error.js";

describe("computer wake error", () => {
  it("keeps the failure visible after a status refresh", () => {
    const botId = "bot-1";
    let errors = clearComputerWakeError(new Map(), botId);
    errors = rememberComputerWakeError(errors, botId, "Team desktop did not become ready.");
    const refreshed = { state: "suspended", busyBotName: null as string | null };
    expect(visibleComputerWakeError(errors, botId, refreshed.state)).toBe(
      "Team desktop did not become ready.",
    );
    expect(visibleComputerWakeError(errors, botId, "stopped")).toBe(
      "Team desktop did not become ready.",
    );
    expect(errors.get(botId)).toBe("Team desktop did not become ready.");
  });

  it("clears only when a new wake starts or one succeeds", () => {
    const botId = "bot-1";
    let errors = rememberComputerWakeError(new Map(), botId, "Could not take control");
    errors = clearComputerWakeError(errors, botId);
    expect(visibleComputerWakeError(errors, botId, "suspended")).toBeNull();
    errors = rememberComputerWakeError(errors, botId, "Could not take control");
    errors = clearComputerWakeError(errors, botId);
    expect(visibleComputerWakeError(errors, botId, "stopped")).toBeNull();
  });

  it("hides a stored failure while the desktop is booting or running", () => {
    const errors = rememberComputerWakeError(new Map(), "bot-1", "Could not take control");
    expect(visibleComputerWakeError(errors, "bot-1", "booting")).toBeNull();
    expect(visibleComputerWakeError(errors, "bot-1", "running")).toBeNull();
    expect(visibleComputerWakeError(errors, "other", "suspended")).toBeNull();
  });
});
