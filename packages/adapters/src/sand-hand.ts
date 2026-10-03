import type { ConnectorTool } from "@rakazo/adapter-kit";
import { builtinAgentTools } from "./builtin-tools.js";
import { MODEL_CANNOT_SEE_MESSAGE } from "./model-vision.js";

/** Action kinds shared by stock computer_act and the sand computer-use RPC. */
export const SAND_HAND_ACTION_KINDS = [
  "click",
  "move",
  "down",
  "up",
  "type",
  "key",
  "scroll",
  "wait",
] as const;

/** Parsed computer actions and tool names sand hands refuse. */
const SAND_REFUSED_KINDS = new Set(["focus", "open", "launch", "open_path", "launch_app"]);

export const SAND_HAND_REFUSAL = "sand hands do not support focus, open_path, or launch_app.";

const SAND_COMPUTER_ACT_DESCRIPTION =
  "Perform up to 24 ordered desktop actions on this bot's computer and return the resulting screen. Batch only predictable actions; stop before an outcome you need to inspect. Action kinds: click, move, down, up, type, key, scroll, wait. focus, open_path, and launch_app are not available.";

const OPEN_PATH_HINT = " Open visual or binary files with open_path instead.";

const FILESYSTEM_SENTENCE = `You have a persistent computer filesystem and shell. ${MODEL_CANNOT_SEE_MESSAGE} Desktop observe and act tools are unavailable until a vision-capable model is selected. Use the file tools and shell.`;

const VISION_INSTRUCTION = `You have a persistent computer. Use computer_observe and computer_act for the visible desktop. computer_act kinds: click, move, down, up, type, key, scroll, wait. ${SAND_HAND_REFUSAL} Batch predictable actions with observe:false; observe before coordinate actions, after navigation, or when the outcome is uncertain. Use the file tools and shell for precise filesystem and terminal work.`;

export function sandHandRefuses(kind: string): boolean {
  return SAND_REFUSED_KINDS.has(kind);
}

/** Turn guidance for a sand computer. Non-vision models keep the filesystem sentence and the same refusals. */
export function sandComputerInstruction(seesDesktop: boolean): string {
  return seesDesktop ? VISION_INSTRUCTION : `${FILESYSTEM_SENTENCE} ${SAND_HAND_REFUSAL}`;
}

/** Drop open_path and launch_app, and advertise only the sand computer_act kinds. */
export function sandHandToolSurface<T extends ConnectorTool>(tools: readonly T[]): T[] {
  return tools.flatMap((tool) => {
    if (tool.name === "open_path" || tool.name === "launch_app") return [];
    if (tool.name === "computer_act") return [sandComputerActTool() as T];
    if (tool.name === "read_file" && tool.description.includes(OPEN_PATH_HINT)) {
      return [{ ...tool, description: tool.description.replace(OPEN_PATH_HINT, "") }];
    }
    return [tool];
  });
}

function sandComputerActTool(): ConnectorTool {
  const stock = builtinAgentTools.find((tool) => tool.name === "computer_act");
  if (!stock) throw new Error("computer_act is missing from builtin tools");
  const inputSchema = structuredClone(stock.inputSchema);
  dropFocusBranch(inputSchema);
  return {
    name: stock.name,
    description: SAND_COMPUTER_ACT_DESCRIPTION,
    inputSchema,
  };
}

function dropFocusBranch(schema: Record<string, unknown>): void {
  const properties = record(schema.properties);
  const actions = record(properties?.actions);
  const items = record(actions?.items);
  if (!items || !Array.isArray(items.oneOf)) return;
  items.oneOf = items.oneOf.filter((branch) => !isFocusOnlyBranch(branch));
}

function isFocusOnlyBranch(branch: unknown): boolean {
  const properties = record(record(branch)?.properties);
  const kind = record(properties?.kind);
  const values = kind?.enum;
  return Array.isArray(values) && values.length === 1 && values[0] === "focus";
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}
