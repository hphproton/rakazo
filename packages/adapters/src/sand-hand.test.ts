import { describe, expect, it } from "vitest";
import { builtinAgentTools } from "./builtin-tools.js";
import { selectBuiltinToolsForRun } from "./executor.js";
import { MODEL_CANNOT_SEE_MESSAGE } from "./model-vision.js";
import {
  SAND_HAND_ACTION_KINDS,
  SAND_HAND_REFUSAL,
  sandComputerInstruction,
  sandHandRefuses,
  sandHandToolSurface,
  sandSeatHands,
} from "./sand-hand.js";
import { sandImageMeta } from "./sand-host.js";

function kindEnums(tool: { inputSchema: Record<string, unknown> }): string[][] {
  const properties = tool.inputSchema.properties;
  if (!properties || typeof properties !== "object") return [];
  const actions = (properties as { actions?: { items?: { oneOf?: unknown[] } } }).actions;
  const oneOf = actions?.items?.oneOf ?? [];
  return oneOf.flatMap((branch) => {
    if (!branch || typeof branch !== "object") return [];
    const kind = (branch as { properties?: { kind?: { enum?: unknown } } }).properties?.kind?.enum;
    return Array.isArray(kind) ? [kind.map(String)] : [];
  });
}

function riffWebp(chunks: { fourcc: string; payload: number[] }[]): Uint8Array {
  const body: number[] = [];
  for (const chunk of chunks) {
    body.push(
      ...[...chunk.fourcc].map((char) => char.charCodeAt(0)),
      chunk.payload.length & 255,
      (chunk.payload.length >> 8) & 255,
      (chunk.payload.length >> 16) & 255,
      (chunk.payload.length >> 24) & 255,
      ...chunk.payload,
    );
    if (chunk.payload.length % 2) body.push(0);
  }
  const bytes = new Uint8Array(12 + body.length);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0);
  const size = 4 + body.length;
  bytes[4] = size & 255;
  bytes[5] = (size >> 8) & 255;
  bytes[6] = (size >> 16) & 255;
  bytes[7] = (size >> 24) & 255;
  bytes.set([0x57, 0x45, 0x42, 0x50], 8);
  bytes.set(body, 12);
  return bytes;
}

function vp8x(width: number, height: number): number[] {
  const canvasWidth = width - 1;
  const canvasHeight = height - 1;
  return [
    0,
    0,
    0,
    0,
    canvasWidth & 255,
    (canvasWidth >> 8) & 255,
    (canvasWidth >> 16) & 255,
    canvasHeight & 255,
    (canvasHeight >> 8) & 255,
    (canvasHeight >> 16) & 255,
  ];
}

function vp8Keyframe(width: number, height: number): number[] {
  return [
    0,
    0,
    0,
    0x9d,
    0x01,
    0x2a,
    width & 255,
    (width >> 8) & 0x3f,
    height & 255,
    (height >> 8) & 0x3f,
  ];
}

describe("sand hand tool surface", () => {
  it("keeps observe and the eight computer-use kinds, and drops focus, open, and launch", () => {
    const stockAct = builtinAgentTools.find((tool) => tool.name === "computer_act");
    const stockSchema = structuredClone(stockAct?.inputSchema);
    const stockDescription = stockAct?.description;
    const surface = sandHandToolSurface(builtinAgentTools);
    const names = surface.map((tool) => tool.name);

    expect(names).toContain("computer_observe");
    expect(names).toContain("computer_act");
    expect(names).not.toContain("open_path");
    expect(names).not.toContain("launch_app");
    expect(stockAct?.description).toBe(stockDescription);
    expect(stockAct?.inputSchema).toEqual(stockSchema);
    expect(
      kindEnums(stockAct ?? { inputSchema: {} }).some((kinds) => kinds.includes("focus")),
    ).toBe(true);

    const act = surface.find((tool) => tool.name === "computer_act");
    const enums = kindEnums(act ?? { inputSchema: {} });
    expect(enums).toEqual([[...SAND_HAND_ACTION_KINDS]]);
    expect(act?.description).toContain("click, move, down, up, type, key, scroll, wait");
    expect(act?.description).toContain("focus, open_path, and launch_app are not available.");
    const readFile = surface.find((tool) => tool.name === "read_file");
    expect(readFile?.description).not.toContain("open_path");
    expect(builtinAgentTools.find((tool) => tool.name === "read_file")?.description).toContain(
      "open_path",
    );
  });

  it("names the allowed kinds for a vision model and keeps the filesystem sentence otherwise", () => {
    const vision = sandComputerInstruction(true);
    for (const kind of SAND_HAND_ACTION_KINDS) expect(vision).toContain(kind);
    expect(vision).toContain(SAND_HAND_REFUSAL);
    expect(vision).not.toContain("Use open_path and launch_app");

    const blind = sandComputerInstruction(false);
    expect(blind).toContain(
      `You have a persistent computer filesystem and shell. ${MODEL_CANNOT_SEE_MESSAGE} Desktop observe and act tools are unavailable until a vision-capable model is selected. Use the file tools and shell.`,
    );
    expect(blind).toContain(SAND_HAND_REFUSAL);
    expect(sandHandRefuses("focus")).toBe(true);
    expect(sandHandRefuses("open")).toBe(true);
    expect(sandHandRefuses("launch")).toBe(true);
    expect(sandHandRefuses("click")).toBe(false);
    expect(sandSeatHands("sand", "dedicated")).toBe(true);
    expect(sandSeatHands("sand", "team")).toBe(false);
    expect(sandSeatHands("docker", "team")).toBe(false);
  });

  it("hides screenshot tools without vision and drops open and launch when sand hands are on", () => {
    const names = (graphicalToolsAllowed: boolean, sandHands = false) =>
      selectBuiltinToolsForRun({
        graphicalToolsAllowed,
        pageBrowserAllowed: false,
        sandHands,
        groupId: null,
        trigger: "user",
        semanticMemoryEnabled: false,
        messagingChannelRun: false,
      }).map((tool) => tool.name);

    expect(names(true)).toEqual(
      expect.arrayContaining(["computer_observe", "computer_act", "open_path", "launch_app"]),
    );
    const sand = names(true, true);
    expect(sand).toEqual(expect.arrayContaining(["computer_observe", "computer_act"]));
    expect(sand).not.toEqual(expect.arrayContaining(["open_path", "launch_app"]));
    const blind = names(false, true);
    expect(blind).not.toEqual(
      expect.arrayContaining(["computer_observe", "computer_act", "open_path", "launch_app"]),
    );
  });
});

describe("sand screenshot dimensions", () => {
  it("reads a lossy VP8 keyframe and prefers a non-zero VP8X canvas", () => {
    expect(
      sandImageMeta(riffWebp([{ fourcc: "VP8 ", payload: vp8Keyframe(320, 200) }])),
    ).toMatchObject({ mimeType: "image/webp", width: 320, height: 200 });
    expect(sandImageMeta(riffWebp([{ fourcc: "VP8X", payload: vp8x(640, 480) }]))).toMatchObject({
      mimeType: "image/webp",
      width: 640,
      height: 480,
    });
    expect(
      sandImageMeta(
        riffWebp([
          { fourcc: "VP8X", payload: vp8x(640, 480) },
          { fourcc: "VP8 ", payload: vp8Keyframe(10, 10) },
        ]),
      ),
    ).toMatchObject({ width: 640, height: 480 });
    expect(
      sandImageMeta(
        riffWebp([
          { fourcc: "ALPH", payload: [0] },
          { fourcc: "VP8 ", payload: vp8Keyframe(800, 600) },
        ]),
      ),
    ).toMatchObject({ width: 800, height: 600 });
  });
});
