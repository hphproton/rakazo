import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { NO_SANDBOX_MESSAGE } from "./none-sandbox.js";
import { createSandboxProvider } from "./sandbox-factory.js";

const AGENT_A = "11111111-1111-4111-8111-111111111111";
const AGENT_B = "22222222-2222-4222-8222-222222222222";

const ctx = {
  operationId: "op",
  traceId: "tr",
  spaceId: "ws",
  userId: "user",
  signal: new AbortController().signal,
};

describe("createSandboxProvider", () => {
  it("returns fake sandbox when explicitly requested", () => {
    const sandbox = createSandboxProvider("fake", {});
    expect(sandbox.describe().id).toBe("fake");
  });

  it("returns none when requested or when the kind is empty", async () => {
    expect(createSandboxProvider("none", {}).describe().id).toBe("none");
    expect(createSandboxProvider("", {}).describe().id).toBe("none");
    await expect(
      createSandboxProvider("none", {}).provision({ botId: "b", homePath: "/tmp" }, ctx),
    ).rejects.toThrow(NO_SANDBOX_MESSAGE);
  });

  it("returns provider-specific managed sandbox emulators", () => {
    expect(createSandboxProvider("e2b-emulator", {}).describe().id).toBe("e2b-emulator");
    expect(createSandboxProvider("daytona-emulator", {}).describe().id).toBe("daytona-emulator");
    expect(createSandboxProvider("box-emulator", {}).describe()).toMatchObject({
      id: "box-emulator",
      capabilities: { multiScreen: true },
    });
  });

  it("boots without a remote key and keeps computers unavailable", async () => {
    expect(createSandboxProvider("e2b", {}).describe().id).toBe("none");
    expect(createSandboxProvider("daytona", {}).describe().id).toBe("none");
    expect(createSandboxProvider("createos", {}).describe().id).toBe("none");
    expect(createSandboxProvider("box", {}).describe().id).toBe("none");
    await expect(
      createSandboxProvider("e2b", {}).provision({ botId: "b", homePath: "/tmp" }, ctx),
    ).rejects.toThrow(/E2B_API_KEY/);
    await expect(
      createSandboxProvider("createos", {}).provision({ botId: "b", homePath: "/tmp" }, ctx),
    ).rejects.toThrow(/CREATEOS_SANDBOX_API_KEY/);
    expect(
      createSandboxProvider("createos", { createosApiKey: "test-createos-key" }).describe().id,
    ).toBe("createos");
    expect(createSandboxProvider("box", { boxApiKey: "test-box-key" }).describe().id).toBe("box");
  });

  it("selects sand and still refuses a bot id that has no seat", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    try {
      const sandbox = createSandboxProvider("sand", {});
      expect(sandbox.describe()).toMatchObject({
        id: "sand",
        capabilities: { graphical: true, multiScreen: false },
      });
      await expect(
        sandbox.provision({ botId: "11111111-1111-4111-8111-111111111111", homePath: "/tmp" }, ctx),
      ).rejects.toThrow(/no seat policy/i);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("resolves every listed bot and refuses one that is not listed", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    try {
      const sandbox = createSandboxProvider("sand", {
        sandSeatMap: JSON.stringify({ "bot-a": AGENT_A, "bot-b": AGENT_B }),
      });
      await expect(
        sandbox.provision({ botId: "bot-a", homePath: "/tmp" }, ctx),
      ).resolves.toMatchObject({ providerRef: AGENT_A, fresh: false });
      await expect(
        sandbox.provision({ botId: "bot-b", homePath: "/tmp" }, ctx),
      ).resolves.toMatchObject({ providerRef: AGENT_B, fresh: false });
      await expect(sandbox.provision({ botId: "bot-c", homePath: "/tmp" }, ctx)).rejects.toThrow(
        /no seat policy/i,
      );
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("resolves a mapped bot and still refuses an unmapped one", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      Response.json({ computerUseSupported: true }),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const sandbox = createSandboxProvider("sand", {
        sandSeatMap: JSON.stringify({ "bot-a": AGENT_A }),
      });
      await expect(sandbox.provision({ botId: "bot-b", homePath: "/tmp" }, ctx)).rejects.toThrow(
        /no seat policy/i,
      );
      expect(fetchMock).not.toHaveBeenCalled();
      const computer = await sandbox.provision({ botId: "bot-a", homePath: "/tmp" }, ctx);
      expect(computer).toMatchObject({
        botId: "bot-a",
        kind: "sand",
        providerRef: AGENT_A,
        fresh: false,
      });
      expect(fetchMock).not.toHaveBeenCalled();
      await sandbox.prepare(computer, ctx);
      expect(fetchMock).toHaveBeenCalledOnce();
      const call = fetchMock.mock.calls[0];
      if (!call) throw new Error("expected a sand host request");
      const [url, init] = call;
      expect(String(url)).toContain("/agent.v1.ControlService/GetCapabilities");
      expect(new Headers(init?.headers).get("x-sand-agent-id")).toBe(AGENT_A);
      expect(String(url)).not.toContain("createAgent");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("loads a seat map from a JSON file and still refuses ids that are missing", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sand-seats-"));
    const file = path.join(dir, "seats.json");
    writeFileSync(file, JSON.stringify({ "bot-a": ` ${AGENT_A} ` }));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    try {
      const sandbox = createSandboxProvider("sand", { sandSeatMap: file });
      await expect(
        sandbox.provision({ botId: "bot-a", homePath: "/tmp" }, ctx),
      ).resolves.toMatchObject({ providerRef: AGENT_A, fresh: false });
      await expect(sandbox.provision({ botId: "bot-b", homePath: "/tmp" }, ctx)).rejects.toThrow(
        /no seat policy/i,
      );
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a seat map that invents an agent, echoes the bot id, or selects a shared display", () => {
    expect(() =>
      createSandboxProvider("sand", { sandSeatMap: JSON.stringify({ "bot-a": "createAgent" }) }),
    ).toThrow(/not a sand agent UUID/);
    expect(() =>
      createSandboxProvider("sand", { sandSeatMap: JSON.stringify({ "bot-a": ":1" }) }),
    ).toThrow(/display :1 or :3/);
    expect(() =>
      createSandboxProvider("sand", { sandSeatMap: JSON.stringify({ "bot-a": ":3" }) }),
    ).toThrow(/display :1 or :3/);
    expect(() =>
      createSandboxProvider("sand", { sandSeatMap: JSON.stringify({ [AGENT_A]: AGENT_A }) }),
    ).toThrow(/Rakazo bot id/);
    expect(() =>
      createSandboxProvider("sand", {
        sandSeatMap: path.join(tmpdir(), "missing-sand-seats.json"),
      }),
    ).toThrow(/file could not be read/);
  });

  it("throws on unknown provider", () => {
    expect(() => createSandboxProvider("bogus", {})).toThrow(
      'Unknown SANDBOX_PROVIDER "bogus". Use none | docker | e2b | daytona | createos | box | e2b-emulator | daytona-emulator | box-emulator | desktop | sand | fake.',
    );
  });
});
