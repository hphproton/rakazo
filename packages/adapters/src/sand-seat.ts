/**
 * A sand seat is an existing sand agent id. Rakazo bot ids are not seats.
 * The host has no attach call that accepts a bot id, and this policy does not
 * create or borrow an agent.
 */
export interface SandSeat {
  agentId: string;
}

export interface SandSeatRequest {
  botId: string;
  providerRef?: string;
}

/** Maps a Rakazo bot id to an existing sand agent. Unmapped ids are refused. */
export interface SandSeatPolicy {
  resolve(request: SandSeatRequest): SandSeat | undefined;
}

/** Built-in policy until one exists for ids that are not sand agent UUIDs. */
export class RefusingSandSeatPolicy implements SandSeatPolicy {
  resolve(): undefined {
    return undefined;
  }
}

export class SandSeatUnmappedError extends Error {
  readonly botId: string;

  constructor(botId: string) {
    super(
      `No sand seat for ${botId}. A Rakazo bot id is not a sand agent id, and no seat policy maps it.`,
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

/**
 * Apply the seat policy. A stored provider ref is not a seat, and neither is
 * the bot id, even when that id is already a UUID.
 */
export function requireSandSeat(policy: SandSeatPolicy, request: SandSeatRequest): SandSeat {
  const seat = policy.resolve(request);
  if (!seat) throw new SandSeatUnmappedError(request.botId);
  assertSandAgentId(seat.agentId);
  if (seat.agentId === request.botId) {
    throw new SandSeatInvalidError(
      "Seat policy returned the Rakazo bot id. That id is not a sand agent UUID.",
    );
  }
  if (request.providerRef !== undefined && request.providerRef !== seat.agentId) {
    throw new SandSeatUnmappedError(request.botId);
  }
  return { agentId: seat.agentId };
}
