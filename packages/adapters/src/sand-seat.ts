import { readFileSync } from "node:fs";

/**
 * A sand seat is an existing sand agent id. Rakazo bot ids are not seats.
 * The host has no attach call that accepts a bot id, and this policy does not
 * create an agent.
 */
export interface SandSeat {
  agentId: string;
}

export interface SandSeatRequest {
  /**
   * Id passed to sandbox provision as `botId`. The product puts the computer
   * home key here: the bot id for a dedicated computer, `team-` plus the space
   * id for a shared Team Computer.
   */
  botId: string;
  /** Rakazo bot id from the adapter context, when the caller has one. */
  callerBotId?: string;
  providerRef?: string;
}

/** Maps a bot id or a computer home key to an existing sand agent. Unmapped ids are refused. */
export interface SandSeatPolicy {
  resolve(request: SandSeatRequest): SandSeat | undefined;
}

/** Used when `SANDBOX_SAND_SEAT_MAP` is unset. Every bot id is unmapped. */
export class RefusingSandSeatPolicy implements SandSeatPolicy {
  resolve(): undefined {
    return undefined;
  }
}

/**
 * Operator map. Keys are bot ids or computer home keys. A bot id entry is used
 * before the shared team home key. Unlisted ids still resolve to nothing.
 */
export class MappedSandSeatPolicy implements SandSeatPolicy {
  constructor(private readonly seats: ReadonlyMap<string, string>) {}

  resolve(request: SandSeatRequest): SandSeat | undefined {
    const keys = [request.callerBotId, request.botId].filter((key): key is string => Boolean(key));
    for (const key of keys) {
      const agentId = this.seats.get(key);
      if (agentId !== undefined) return { agentId };
    }
    return undefined;
  }
}

const SEAT_MAP_ERROR =
  "SANDBOX_SAND_SEAT_MAP must be a JSON object of bot id or team home key to sand agent UUID.";

/**
 * Build the seat policy from `SANDBOX_SAND_SEAT_MAP`.
 * The value is a JSON object, or a path to a file that contains one.
 * An unset value refuses every bot. Unmapped ids still resolve to nothing.
 */
export function sandSeatPolicyFromConfig(raw: string | undefined): SandSeatPolicy {
  const value = raw?.trim();
  if (!value) return new RefusingSandSeatPolicy();
  return new MappedSandSeatPolicy(parseSandSeatMap(seatMapText(value)));
}

function seatMapText(value: string): string {
  if (value.startsWith("{")) return value;
  try {
    return readFileSync(value, "utf8");
  } catch {
    throw new Error("SANDBOX_SAND_SEAT_MAP file could not be read.");
  }
}

export function parseSandSeatMap(text: string): Map<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(SEAT_MAP_ERROR);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(SEAT_MAP_ERROR);
  }
  const seats = new Map<string, string>();
  for (const [botId, agentId] of Object.entries(parsed)) {
    if (!botId || typeof agentId !== "string") throw new Error(SEAT_MAP_ERROR);
    const id = agentId.trim();
    assertSandAgentId(id);
    if (id === botId) {
      throw new SandSeatInvalidError(
        "Seat policy returned the Rakazo bot id. That id is not a sand agent UUID.",
      );
    }
    seats.set(botId, id);
  }
  return seats;
}

export class SandSeatUnmappedError extends Error {
  readonly botId: string;

  constructor(botId: string, callerBotId?: string) {
    const who = callerBotId && callerBotId !== botId ? `${botId} or ${callerBotId}` : botId;
    super(
      `No sand seat for ${who}. A Rakazo bot id is not a sand agent id, and no seat policy maps it.`,
    );
    this.name = "SandSeatUnmappedError";
    this.botId = botId;
  }
}

export class SandSeatInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandSeatInvalidError";
  }
}

export class SandDisplayForbiddenError extends Error {
  constructor() {
    super("Sand screens do not attach to display :1 or :3.");
    this.name = "SandDisplayForbiddenError";
  }
}

const SAND_AGENT_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Display :1 and :3 are the shared host seats. Port numbers such as :1339 do not match. */
export function sandScreenSelectsForbiddenDisplay(value: string): boolean {
  return (
    /(?:^|[^\d]):(?:1|3)(?!\d)/.test(value) || /display(?:=|:|\/|\s)+:?(?:1|3)(?!\d)/i.test(value)
  );
}

export function assertSandAgentId(agentId: string): void {
  if (sandScreenSelectsForbiddenDisplay(agentId)) throw new SandDisplayForbiddenError();
  if (agentId.includes("/") || agentId.includes("\\") || /\s/.test(agentId)) {
    throw new SandSeatInvalidError("Seat policy returned an id that is not a sand agent UUID.");
  }
  if (!SAND_AGENT_UUID.test(agentId)) {
    throw new SandSeatInvalidError("Seat policy returned an id that is not a sand agent UUID.");
  }
}

/** True when `value` is a sand agent UUID. A `fake-` id and any other provider ref are not. */
export function isSandAgentId(value: string): boolean {
  return SAND_AGENT_UUID.test(value);
}

/**
 * Apply the seat policy. A stored provider ref is not a seat. A leftover ref
 * from another provider, including `fake-<home key>`, does not veto the map.
 * A different sand agent UUID does. The bot id is not a seat either, even when
 * that id is already a UUID.
 */
export function requireSandSeat(policy: SandSeatPolicy, request: SandSeatRequest): SandSeat {
  const seat = policy.resolve(request);
  if (!seat) throw new SandSeatUnmappedError(request.botId, request.callerBotId);
  assertSandAgentId(seat.agentId);
  if (seat.agentId === request.botId || seat.agentId === request.callerBotId) {
    throw new SandSeatInvalidError(
      "Seat policy returned the Rakazo bot id. That id is not a sand agent UUID.",
    );
  }
  const stored = request.providerRef?.trim();
  if (stored && isSandAgentId(stored) && stored !== seat.agentId) {
    throw new SandSeatUnmappedError(request.botId);
  }
  return { agentId: seat.agentId };
}
