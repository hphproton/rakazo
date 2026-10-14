export type ComputerScreenSurface = "card" | "overlay";

/**
 * The preview card is always a view seal. The overlay asks for control, and
 * the server still grants it only while this bot's lease is held.
 */
export function computerScreenUrlInput(botId: string, surface: ComputerScreenSurface) {
  return surface === "card" ? { botId, interactive: false as const } : { botId };
}
