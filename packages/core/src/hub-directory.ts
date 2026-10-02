import { BOT_COLORS, BOT_NAME_MAX_LENGTH, BOT_TITLE_MAX_LENGTH } from "@rakazo/contracts";

/**
 * Directory section for mirrored Hub members.
 * Member lists omit this section. It is not a sidebar people open.
 */
export const HUB_SECTION_NAME = "Hub";

/** Reserved spawnKey prefix. Rows with this prefix are Hub roster mirrors, not workspace bots. */
export const HUB_SPAWN_KEY_PREFIX = "hub:";

/** Shown when a person or `message_bot` tries to open a Hub roster row as a chat. */
export const HUB_MIRROR_NOT_A_CHAT = "Hub members are not chats. Use hub_send_message.";

/**
 * Member-list filter. Hub roster rows stay addressable for `hub_send_message`
 * and are not sidebar seats, search hits, or DM targets.
 * `NOT startsWith` drops SQL NULL, so unset spawn keys stay on their own branch.
 */
export const VISIBLE_ROSTER_BOT_WHERE: {
  OR: Array<{ spawnKey: null } | { NOT: { spawnKey: { startsWith: string } } }>;
} = {
  OR: [{ spawnKey: null }, { NOT: { spawnKey: { startsWith: HUB_SPAWN_KEY_PREFIX } } }],
};

export function hubMirrorChatRefusal(spawnKey: string | null | undefined): string | undefined {
  return hubAgentIdFromSpawnKey(spawnKey) ? HUB_MIRROR_NOT_A_CHAT : undefined;
}

/** Hub → Rakazo identity path. Prefer this over threads/send and bot webhooks. */
export const HUB_INBOUND_PROCEDURE = "threads/receiveHub" as const;

/**
 * Advertised R→H label on cutover responses. The builtin `hub_send_message`
 * tool writes the first-party hub/outbox drain; a host mesh consumes that.
 */
export const RAKAZO_TO_HUB_PATH = "mcp" as const;

export const HUB_INBOUND_CUTOVER_ERROR = "Hub inbound uses threads/receiveHub";

/** Paths that must not carry Hub identity. Webhook refusal uses this list. */
export const DEPRECATED_HUB_INBOUND_PROCEDURES = ["threads/send", "webhook"] as const;

export class HubRosterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HubRosterError";
  }
}

export type HubMemberDraft = {
  hubAgentId: string;
  name: string;
  title?: string;
};

export type HubRosterRecord = {
  id: string;
  name: string;
  title: string;
  archived: boolean;
  spawnKey: string | null;
  sectionId: string | null;
  updatedAt: string;
};

export type HubDirectoryMember = {
  hubAgentId: string;
  botId: string;
  name: string;
  title: string;
  archived: boolean;
};

export type HubDirectoryBot = {
  id: string;
  name: string;
  title: string;
  archived: boolean;
  spawnKey: string | null;
};

export type HubDirectory = {
  epoch: string;
  issuedAt: string;
  spaceId: string;
  hubMembers: HubDirectoryMember[];
  rakazoBots: HubDirectoryBot[];
};

export type HubRosterPlan = {
  create: Array<{ hubAgentId: string; spawnKey: string; name: string; title: string }>;
  update: Array<{
    botId: string;
    hubAgentId: string;
    name: string;
    title: string;
    unarchive: boolean;
  }>;
  archive: Array<{ botId: string; hubAgentId: string }>;
};

export type HubInboundDelivery = {
  botId: string;
  hubAgentId: string;
  hubAgentName: string;
  text: string;
  intent?: "request" | "question" | "result" | "status" | "fyi";
  clientNonce?: string;
};

export function hubSpawnKey(hubAgentId: string): string {
  const id = hubAgentId.trim();
  if (!id) throw new HubRosterError("Hub agent id is required.");
  return `${HUB_SPAWN_KEY_PREFIX}${id}`;
}

export function hubAgentIdFromSpawnKey(spawnKey: string | null | undefined): string | null {
  if (!spawnKey?.startsWith(HUB_SPAWN_KEY_PREFIX)) return null;
  const id = spawnKey.slice(HUB_SPAWN_KEY_PREFIX.length);
  return id.length > 0 ? id : null;
}

/** Stable color from the existing bot palette so a Hub row does not invent a new hex. */
export function hubRosterColor(hubAgentId: string): string {
  const index = fnv1a32(hubAgentId.trim()) % BOT_COLORS.length;
  return BOT_COLORS[index] ?? BOT_COLORS[0];
}

function normalizeMember(member: HubMemberDraft): {
  hubAgentId: string;
  name: string;
  title: string;
} {
  const hubAgentId = member.hubAgentId.trim();
  const name = member.name.trim();
  const title = (member.title ?? "").trim();
  if (!hubAgentId) throw new HubRosterError("Hub agent id is required.");
  if (!name) throw new HubRosterError("Hub member name is required.");
  if (name.length > BOT_NAME_MAX_LENGTH) {
    throw new HubRosterError(`Hub member name exceeds ${BOT_NAME_MAX_LENGTH} characters.`);
  }
  if (title.length > BOT_TITLE_MAX_LENGTH) {
    throw new HubRosterError(`Hub member title exceeds ${BOT_TITLE_MAX_LENGTH} characters.`);
  }
  return { hubAgentId, name, title };
}

/**
 * Full-snapshot plan. Members omitted here are archived. Workspace bots (any other spawnKey) stay.
 * Matching is by `hub:<hubAgentId>`, so a returning member keeps the same bot id.
 */
export function planHubRosterSync(
  existing: readonly HubRosterRecord[],
  members: readonly HubMemberDraft[],
  hubSectionId: string,
): HubRosterPlan {
  const normalized = members.map(normalizeMember);
  const seen = new Set<string>();
  for (const member of normalized) {
    if (seen.has(member.hubAgentId)) {
      throw new HubRosterError(`Duplicate Hub agent id ${member.hubAgentId}.`);
    }
    seen.add(member.hubAgentId);
  }

  const byAgent = new Map<string, HubRosterRecord>();
  for (const bot of existing) {
    const hubAgentId = hubAgentIdFromSpawnKey(bot.spawnKey);
    if (hubAgentId) byAgent.set(hubAgentId, bot);
  }

  const plan: HubRosterPlan = { create: [], update: [], archive: [] };
  for (const member of normalized) {
    const bot = byAgent.get(member.hubAgentId);
    if (!bot) {
      plan.create.push({
        hubAgentId: member.hubAgentId,
        spawnKey: hubSpawnKey(member.hubAgentId),
        name: member.name,
        title: member.title,
      });
      continue;
    }
    const dirty =
      bot.archived ||
      bot.name !== member.name ||
      bot.title !== member.title ||
      bot.sectionId !== hubSectionId;
    if (dirty) {
      plan.update.push({
        botId: bot.id,
        hubAgentId: member.hubAgentId,
        name: member.name,
        title: member.title,
        unarchive: bot.archived,
      });
    }
  }

  for (const bot of existing) {
    const hubAgentId = hubAgentIdFromSpawnKey(bot.spawnKey);
    if (!hubAgentId || seen.has(hubAgentId) || bot.archived) continue;
    plan.archive.push({ botId: bot.id, hubAgentId });
  }

  return plan;
}

export function buildHubDirectory(input: {
  spaceId: string;
  bots: readonly HubRosterRecord[];
  issuedAt: string;
}): HubDirectory {
  const hubMembers: HubDirectoryMember[] = [];
  const rakazoBots: HubDirectoryBot[] = [];
  for (const bot of input.bots) {
    const hubAgentId = hubAgentIdFromSpawnKey(bot.spawnKey);
    if (hubAgentId) {
      hubMembers.push({
        hubAgentId,
        botId: bot.id,
        name: bot.name,
        title: bot.title,
        archived: bot.archived,
      });
    } else {
      rakazoBots.push({
        id: bot.id,
        name: bot.name,
        title: bot.title,
        archived: bot.archived,
        spawnKey: bot.spawnKey,
      });
    }
  }
  hubMembers.sort((a, b) => compareIds(a.hubAgentId, b.hubAgentId));
  rakazoBots.sort((a, b) => compareIds(a.id, b.id));
  const epoch = hubRosterEpoch(input.spaceId, hubMembers, rakazoBots);
  return {
    epoch,
    issuedAt: input.issuedAt,
    spaceId: input.spaceId,
    hubMembers,
    rakazoBots,
  };
}

/** Content epoch. It ignores issuedAt, so a second read of the same roster keeps the same epoch. */
export function hubRosterEpoch(
  spaceId: string,
  hubMembers: readonly HubDirectoryMember[],
  rakazoBots: readonly HubDirectoryBot[],
): string {
  return fnv1a64(canonicalRosterBody(spaceId, hubMembers, rakazoBots));
}

/** Bytes covered by the directory HMAC. issuedAt is intentionally outside the signature. */
export function canonicalHubDirectoryBody(
  directory: Pick<HubDirectory, "epoch" | "spaceId" | "hubMembers" | "rakazoBots">,
): string {
  return JSON.stringify({
    epoch: directory.epoch,
    spaceId: directory.spaceId,
    hubMembers: directory.hubMembers,
    rakazoBots: directory.rakazoBots,
  });
}

export function hubInboundCutover(procedure: string): {
  procedure: typeof HUB_INBOUND_PROCEDURE;
  rakazoToHub: typeof RAKAZO_TO_HUB_PATH;
  deprecated: boolean;
} {
  return {
    procedure: HUB_INBOUND_PROCEDURE,
    rakazoToHub: RAKAZO_TO_HUB_PATH,
    deprecated:
      procedure !== HUB_INBOUND_PROCEDURE ||
      (DEPRECATED_HUB_INBOUND_PROCEDURES as readonly string[]).includes(procedure),
  };
}

export function hubInboundCall(delivery: HubInboundDelivery): {
  procedure: typeof HUB_INBOUND_PROCEDURE;
  input: HubInboundDelivery;
} {
  return { procedure: HUB_INBOUND_PROCEDURE, input: delivery };
}

/**
 * A webhook body that is trying to be a Hub delivery. Ordinary webhook JSON
 * without these fields still lands as a plain user message.
 */
export function isHubInboundEnvelope(payload: Record<string, unknown>): boolean {
  if (payload.origin === "hub") return true;
  if (payload.event === "hub_message") return true;
  return (
    typeof payload.hubAgentId === "string" &&
    payload.hubAgentId.trim().length > 0 &&
    typeof payload.hubAgentName === "string" &&
    payload.hubAgentName.trim().length > 0
  );
}

function canonicalRosterBody(
  spaceId: string,
  hubMembers: readonly HubDirectoryMember[],
  rakazoBots: readonly HubDirectoryBot[],
): string {
  return JSON.stringify({ spaceId, hubMembers, rakazoBots });
}

function compareIds(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function fnv1a32(value: string): number {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function fnv1a64(value: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= BigInt(byte);
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, "0");
}
