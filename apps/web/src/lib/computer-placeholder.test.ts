import { describe, expect, it, vi } from "vitest";

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw(strings, ...values),
}));

import { computerPlaceholder } from "./computer-placeholder";

describe("computerPlaceholder", () => {
  it("keeps a running seat's label and does not call the machine idle or stopped", () => {
    expect(computerPlaceholder("running", false, "Atlas’s computer")).toBe("Atlas’s computer");
    expect(computerPlaceholder("running", false, "Team Computer")).toBe("Team Computer");
    for (const label of ["Atlas’s computer", "Team Computer"]) {
      const text = computerPlaceholder("running", false, label);
      expect(text).not.toMatch(/idle/i);
      expect(text).not.toMatch(/stopped/i);
      expect(text).not.toMatch(/connected/i);
      expect(text).not.toMatch(/reconnecting/i);
      expect(text).not.toMatch(/stale/i);
    }
  });

  it("says the machine is off only when it is stopped, asleep, or failed", () => {
    expect(computerPlaceholder("stopped", false, "Atlas’s computer")).toBe("Computer is stopped");
    expect(computerPlaceholder(undefined, false, "Atlas’s computer")).toBe("Computer is stopped");
    expect(computerPlaceholder("suspended", false, "Atlas’s computer")).toBe(
      "Computer is asleep. Open it to wake.",
    );
    expect(computerPlaceholder("error", false, "Atlas’s computer")).toBe("Computer failed to boot");
    expect(computerPlaceholder("booting", false, "Atlas’s computer")).toBe("Booting live desktop…");
    expect(computerPlaceholder("running", true, "Atlas’s computer")).toBe("Booting live desktop…");
  });
});
