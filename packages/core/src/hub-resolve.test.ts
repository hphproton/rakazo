import { describe, expect, it } from "vitest";
import {
  HUB_DIRECTORY_PROMPT_LIMIT,
  HUB_RESOLVE_AMBIGUOUS_LIMIT,
  type HubResolveMember,
  renderHubDirectory,
  resolveHubMember,
} from "./hub-resolve.js";

const principal: HubResolveMember = {
  hubAgentId: "f4adcc55-1111-4111-8111-111111111111",
  name: "Box Principal",
  title: "Principal",
};

const pi: HubResolveMember = {
  hubAgentId: "pi-ops",
  name: "Pi Ops",
  title: "Ops",
};

const lab: HubResolveMember = {
  hubAgentId: "lab-1",
  name: "Lab",
  title: "Research",
};

describe("resolveHubMember", () => {
  it("requires a target or hubAgentId", () => {
    expect(resolveHubMember([principal], {})).toEqual({ ok: false, error: "target_required" });
    expect(resolveHubMember([principal], { hubAgentId: "  ", target: " " })).toEqual({
      ok: false,
      error: "target_required",
    });
  });

  it("matches an explicit id, including case and archived rows", () => {
    const archived = { ...principal, archived: true };
    const resolved = resolveHubMember([archived, pi], {
      hubAgentId: "F4ADCC55-1111-4111-8111-111111111111",
      target: "Lab",
    });
    expect(resolved).toEqual({ ok: true, member: archived });
  });

  it("does not fall through to a name when the explicit id misses", () => {
    expect(
      resolveHubMember([principal], { hubAgentId: "missing-id", target: "Box Principal" }),
    ).toEqual({ ok: false, error: "not_found", target: "missing-id" });
  });

  it("matches a unique name without a TO_HUB prefix", () => {
    expect(resolveHubMember([principal, pi], { target: "  box principal " })).toEqual({
      ok: true,
      member: principal,
    });
  });

  it("prefers one exact name over a longer fuzzy name", () => {
    const atlas: HubResolveMember = { hubAgentId: "atlas", name: "Atlas", title: "Maps" };
    const atlasLab: HubResolveMember = { hubAgentId: "atlas-lab", name: "Atlas Lab", title: "" };
    expect(resolveHubMember([atlasLab, atlas], { target: "Atlas" })).toEqual({
      ok: true,
      member: atlas,
    });
  });

  it("uses a unique exact title", () => {
    const ada: HubResolveMember = { hubAgentId: "ada", name: "Ada", title: "Principal" };
    expect(resolveHubMember([ada, pi], { target: "principal" })).toEqual({
      ok: true,
      member: ada,
    });
  });

  it("fuzzy-matches a unique name fragment on a word boundary", () => {
    expect(resolveHubMember([principal, lab], { target: "Box" })).toEqual({
      ok: true,
      member: principal,
    });
    expect(resolveHubMember([pi, lab], { target: "Ops" })).toEqual({ ok: true, member: pi });
  });

  it("does not treat a short fragment inside a longer word as a hit", () => {
    const onlyPi: HubResolveMember = { hubAgentId: "pi", name: "Pi", title: "" };
    expect(resolveHubMember([onlyPi], { target: "Principal" })).toEqual({
      ok: false,
      error: "not_found",
      target: "Principal",
    });
  });

  it("returns not_found and no candidate when nothing matches", () => {
    expect(resolveHubMember([principal], { target: "No Such Agent" })).toEqual({
      ok: false,
      error: "not_found",
      target: "No Such Agent",
    });
  });

  it("skips archived rows for name resolve", () => {
    expect(
      resolveHubMember([{ ...principal, archived: true }], { target: "Box Principal" }),
    ).toEqual({ ok: false, error: "not_found", target: "Box Principal" });
  });

  it("fails closed when two members match, and caps the candidate list", () => {
    const roster: HubResolveMember[] = [
      { hubAgentId: "b", name: "Atlas Beta", title: "Guide" },
      { hubAgentId: "a", name: "Atlas Alpha", title: "Guide" },
      { hubAgentId: "c", name: "Atlas Gamma", title: "" },
      { hubAgentId: "d", name: "Atlas Delta", title: "" },
      { hubAgentId: "e", name: "Atlas Epsilon", title: "" },
      { hubAgentId: "f", name: "Atlas Zeta", title: "" },
    ];
    const resolved = resolveHubMember(roster, { target: "Atlas" });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.error).toBe("ambiguous");
    if (resolved.error !== "ambiguous") return;
    expect(resolved.candidates).toHaveLength(HUB_RESOLVE_AMBIGUOUS_LIMIT);
    expect(resolved.candidates.map((candidate) => candidate.name)).toEqual([
      "Atlas Alpha",
      "Atlas Beta",
      "Atlas Delta",
      "Atlas Epsilon",
      "Atlas Gamma",
    ]);
  });

  it("does not pick the shortest of two fuzzy names", () => {
    const resolved = resolveHubMember(
      [
        { hubAgentId: "long", name: "Atlas Operations", title: "" },
        { hubAgentId: "short", name: "Atlas Ops", title: "" },
      ],
      { target: "Atlas" },
    );
    expect(resolved.ok).toBe(false);
    if (!resolved.ok && resolved.error === "ambiguous") {
      expect(resolved.candidates.map((candidate) => candidate.hubAgentId).sort()).toEqual([
        "long",
        "short",
      ]);
    }
  });
});

describe("renderHubDirectory", () => {
  it("lists active members and states that TO_HUB: does not send", () => {
    const text = renderHubDirectory([
      { ...principal, archived: true },
      pi,
      { hubAgentId: "x<script>", name: "Lab <team>", title: "R&D" },
    ]);
    expect(text).toContain("Writing TO_HUB: in your reply does not send.");
    expect(text).toContain("- Pi Ops (hubAgentId: pi-ops) — Ops");
    expect(text).toContain("Lab &lt;team&gt;");
    expect(text).toContain("hubAgentId: x&lt;script&gt;");
    expect(text).not.toContain("Box Principal");
  });

  it("returns nothing when the directory has no active member", () => {
    expect(renderHubDirectory([{ ...principal, archived: true }])).toBeUndefined();
    expect(renderHubDirectory([])).toBeUndefined();
  });

  it("caps the prompt list", () => {
    const members = Array.from({ length: HUB_DIRECTORY_PROMPT_LIMIT + 5 }, (_, index) => ({
      hubAgentId: `id-${index}`,
      name: `Member ${String(index).padStart(2, "0")}`,
      title: "",
    }));
    const text = renderHubDirectory(members) ?? "";
    const lines = text.split("\n").filter((line) => line.startsWith("- "));
    expect(lines).toHaveLength(HUB_DIRECTORY_PROMPT_LIMIT);
  });
});
