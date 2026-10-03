import { describe, expect, it } from "vitest";
import { resolveSandboxProvider, sandboxProviderOptionsFromEnv } from "./sandbox-provider-env.js";

describe("resolveSandboxProvider", () => {
  it("defaults to docker", () => {
    expect(resolveSandboxProvider({})).toBe("docker");
  });

  it("keeps explicit none", () => {
    expect(resolveSandboxProvider({ SANDBOX_PROVIDER: "none" })).toBe("none");
    expect(resolveSandboxProvider({ SANDBOX_PROVIDER: "" })).toBe("none");
  });

  it("keeps sand selected without a host token", () => {
    expect(resolveSandboxProvider({ SANDBOX_PROVIDER: "sand" })).toBe("sand");
  });

  it("falls back to none when a remote provider key is missing", () => {
    expect(resolveSandboxProvider({ SANDBOX_PROVIDER: "e2b" })).toBe("none");
    expect(resolveSandboxProvider({ SANDBOX_PROVIDER: "daytona" })).toBe("none");
    expect(resolveSandboxProvider({ SANDBOX_PROVIDER: "createos" })).toBe("none");
    expect(resolveSandboxProvider({ SANDBOX_PROVIDER: "box" })).toBe("none");
  });

  it("keeps CreateOS when its API key is set", () => {
    expect(
      resolveSandboxProvider({
        SANDBOX_PROVIDER: "createos",
        CREATEOS_SANDBOX_API_KEY: "test-createos-key",
      }),
    ).toBe("createos");
  });

  it("falls back to none in production when Docker has no supervisor token", () => {
    expect(
      resolveSandboxProvider({
        NODE_ENV: "production",
        SANDBOX_PROVIDER: "docker",
      }),
    ).toBe("none");
  });

  it("keeps docker in production when a supervisor token is set", () => {
    expect(
      resolveSandboxProvider({
        NODE_ENV: "production",
        SANDBOX_PROVIDER: "docker",
        SANDBOX_SUPERVISOR_TOKEN: "prod-supervisor-token-with-enough-length",
      }),
    ).toBe("docker");
  });
});

describe("sandboxProviderOptionsFromEnv", () => {
  it("loads CreateOS settings from the shared env contract", () => {
    expect(
      sandboxProviderOptionsFromEnv({
        CREATEOS_SANDBOX_API_KEY: "test-createos-key",
        CREATEOS_SANDBOX_BASE_URL: "https://api.example.test",
        CREATEOS_SANDBOX_SHAPE: "s-4vcpu-8gb",
        CREATEOS_SANDBOX_ROOTFS: "desktop:2",
      }),
    ).toMatchObject({
      createosApiKey: "test-createos-key",
      createosBaseUrl: "https://api.example.test",
      createosShape: "s-4vcpu-8gb",
      createosRootfs: "desktop:2",
    });
  });

  it("loads the sand-host router without a seat map", () => {
    expect(
      sandboxProviderOptionsFromEnv({
        SAND_HOST_URL: " http://127.0.0.1:1339 ",
        SAND_HOST_TOKEN: " test-sand-token ",
      }),
    ).toMatchObject({
      sandHostUrl: "http://127.0.0.1:1339",
      sandHostToken: "test-sand-token",
      sandSeatMap: undefined,
    });
  });

  it("loads a sand seat map when one is set", () => {
    const sandSeatMap = '{"bot-a":"11111111-1111-4111-8111-111111111111"}';
    expect(
      sandboxProviderOptionsFromEnv({
        SANDBOX_SAND_SEAT_MAP: ` ${sandSeatMap} `,
      }).sandSeatMap,
    ).toBe(sandSeatMap);
  });
});
