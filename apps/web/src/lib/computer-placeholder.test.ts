import { describe, expect, it, vi } from "vitest";
import { computerPlaceholder } from "./computer-placeholder";

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw(strings, ...values),
}));

const OFF = [
  "Computer is stopped",
  "Computer is asleep. Open it to wake.",
  "Computer failed to boot",
];

describe("computerPlaceholder", () => {
  it("uses desktop-off wording only when the computer is stopped, suspended, or failed", () => {
    expect(computerPlaceholder("stopped", false, "Team Computer")).toBe("Computer is stopped");
    expect(computerPlaceholder("suspended", false, "Team Computer")).toBe(
      "Computer is asleep. Open it to wake.",
    );
    expect(computerPlaceholder("error", false, "Team Computer")).toBe("Computer failed to boot");
    expect(computerPlaceholder(undefined, false, "Team Computer")).toBe("Computer is stopped");
  });

  it("keeps a running or booting seat on its label and never calls that Idle or off", () => {
    expect(computerPlaceholder("running", false, "Team Computer")).toBe("Team Computer");
    expect(computerPlaceholder("booting", false, "Team Computer")).toBe("Booting live desktop…");
    expect(computerPlaceholder("running", true, "Chief’s computer")).toBe("Booting live desktop…");
    for (const word of [
      computerPlaceholder("running", false, "Team Computer"),
      computerPlaceholder("booting", false, "Team Computer"),
    ]) {
      expect(word).not.toContain("Idle");
      for (const off of OFF) expect(word).not.toBe(off);
    }
  });
});
