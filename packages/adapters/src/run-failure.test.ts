import { describe, expect, it } from "vitest";
import { redactFailure } from "./run-failure.js";

describe("redactFailure", () => {
  it("keeps the abort name and cause and redacts secret text", () => {
    const cause = new Error("provider said sk-testsecret12345678 after the tool");
    const error = new Error("The operation was aborted");
    error.name = "AbortError";
    error.cause = cause;

    const logged = redactFailure(error, ["sk-testsecret12345678"]);

    expect(logged.name).toBe("AbortError");
    expect(logged.message).toBe("The operation was aborted");
    expect(logged.stack).toBeTruthy();
    expect(logged.cause).toBeInstanceOf(Error);
    expect((logged.cause as Error).name).toBe("Error");
    expect((logged.cause as Error).message).not.toContain("sk-testsecret12345678");
    expect((logged.cause as Error).message).toContain("provider said");
  });
});
