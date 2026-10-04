import { describe, expect, it } from "vitest";
import { directoryReadToolResult, isDirectoryReadFailure } from "./computer-support.js";

describe("directory read recovery", () => {
  it("lists a directory and refuses when the listing itself fails", async () => {
    const eisdir = Object.assign(new Error("EISDIR: illegal operation on a directory, read"), {
      code: "EISDIR",
    });
    expect(isDirectoryReadFailure(eisdir)).toBe(true);
    await expect(directoryReadToolResult(eisdir, async () => ["notes"])).resolves.toEqual({
      entries: ["notes"],
    });
    await expect(
      directoryReadToolResult(eisdir, async () => {
        throw new Error("sandbox file listing failed: 400");
      }),
    ).resolves.toEqual({ error: "path is a directory" });
  });

  it("does not swallow missing files or other read failures", async () => {
    const missing = new Error("computer file not found");
    expect(isDirectoryReadFailure(missing)).toBe(false);
    expect(isDirectoryReadFailure(new Error("ENOTDIR: not a directory"))).toBe(false);
    await expect(
      directoryReadToolResult(missing, async () => {
        throw new Error("list should not run");
      }),
    ).resolves.toBeUndefined();
  });
});
