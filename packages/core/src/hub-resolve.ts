/** How many ambiguous candidates a tool result includes. */
export const HUB_RESOLVE_AMBIGUOUS_LIMIT = 5;

/** Cap for the model-facing directory. The tool still resolves the full roster. */
export const HUB_DIRECTORY_PROMPT_LIMIT = 40;

export type HubResolveMember = {
  hubAgentId: string;
  name: string;
  title: string;
  archived?: boolean;
};

export type HubResolveCandidate = {
  hubAgentId: string;
  name: string;
  title: string;
};

export type HubResolveResult<T extends HubResolveMember> =
  | { ok: true; member: T }
  | { ok: false; error: "target_required" }
  | { ok: false; error: "not_found"; target: string }
  | { ok: false; error: "ambiguous"; candidates: HubResolveCandidate[] };

/**
 * Resolve a Hub directory member.
 *
 * Explicit id wins, including archived rows. Otherwise: exact name, then a
 * unique exact title, then a boundary-aligned substring either way on name
 * and title. More than one fuzzy hit is ambiguous — never a silent pick.
 * Archived rows are skipped unless the id was explicit.
 *
 * A match must sit on a letter or digit boundary, so "Pi" does not count as
 * a hit inside "Principal". Exact name and title still match in full.
 */
export function resolveHubMember<T extends HubResolveMember>(
  members: readonly T[],
  input: { hubAgentId?: string | null; target?: string | null },
): HubResolveResult<T> {
  const hubAgentId = input.hubAgentId?.trim() ?? "";
  const target = input.target?.trim() ?? "";
  if (hubAgentId) {
    const id = hubAgentId.toLowerCase();
    const match = members.find((member) => member.hubAgentId.trim().toLowerCase() === id);
    if (!match) return { ok: false, error: "not_found", target: hubAgentId };
    return { ok: true, member: match };
  }
  if (!target) return { ok: false, error: "target_required" };

  const pool = members.filter((member) => member.archived !== true);
  const needle = target.toLowerCase();
  const exactNames = pool.filter((member) => normalize(member.name) === needle);
  if (exactNames.length === 1) return { ok: true, member: exactNames[0] as T };
  if (exactNames.length > 1) return ambiguous(exactNames);

  const exactTitles = pool.filter((member) => {
    const title = normalize(member.title);
    return title.length > 0 && title === needle;
  });
  if (exactTitles.length === 1) return { ok: true, member: exactTitles[0] as T };

  const fuzzy = pool.filter((member) => fuzzyHit(member, needle));
  if (fuzzy.length === 1) return { ok: true, member: fuzzy[0] as T };
  if (fuzzy.length > 1) return ambiguous(fuzzy);
  return { ok: false, error: "not_found", target };
}

/** Model-facing directory. Empty when every Hub row is archived or missing. */
export function renderHubDirectory(members: readonly HubResolveMember[]): string | undefined {
  const active = members
    .filter((member) => member.archived !== true && member.hubAgentId.trim() && member.name.trim())
    .map((member) => ({
      hubAgentId: member.hubAgentId.trim(),
      name: member.name.trim(),
      title: member.title.trim(),
    }))
    .sort((a, b) => {
      const byName = compareText(a.name.toLowerCase(), b.name.toLowerCase());
      if (byName !== 0) return byName;
      return compareText(a.hubAgentId, b.hubAgentId);
    })
    .slice(0, HUB_DIRECTORY_PROMPT_LIMIT);
  if (active.length === 0) return undefined;
  return [
    "Hub directory for hub_send_message. These names are not chats. Do not call message_bot for them. Writing TO_HUB: in your reply does not send.",
    "<hub_directory>",
    ...active.map((member) => {
      const name = escapeDirectoryField(member.name);
      const id = escapeDirectoryField(member.hubAgentId);
      const title = member.title ? escapeDirectoryField(member.title) : "";
      return `- ${name} (hubAgentId: ${id})${title ? ` — ${title}` : ""}`;
    }),
    "</hub_directory>",
  ].join("\n");
}

function ambiguous<T extends HubResolveMember>(
  members: readonly T[],
): { ok: false; error: "ambiguous"; candidates: HubResolveCandidate[] } {
  const candidates = members
    .map((member) => ({
      hubAgentId: member.hubAgentId,
      name: member.name,
      title: member.title ?? "",
    }))
    .sort((a, b) => {
      const byName = compareText(a.name.trim().toLowerCase(), b.name.trim().toLowerCase());
      if (byName !== 0) return byName;
      return compareText(a.hubAgentId, b.hubAgentId);
    })
    .slice(0, HUB_RESOLVE_AMBIGUOUS_LIMIT);
  return { ok: false, error: "ambiguous", candidates };
}

function fuzzyHit(member: HubResolveMember, needle: string): boolean {
  const name = normalize(member.name);
  const title = normalize(member.title);
  return (
    alignedContains(name, needle) ||
    alignedContains(needle, name) ||
    alignedContains(title, needle) ||
    alignedContains(needle, title)
  );
}

/** True when `needle` occurs in `haystack` on a letter/digit boundary. */
function alignedContains(haystack: string, needle: string): boolean {
  if (!haystack || !needle) return false;
  let from = 0;
  while (from <= haystack.length - needle.length) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) return false;
    const beforeOk = at === 0 || !isWordChar(haystack.charCodeAt(at - 1));
    const end = at + needle.length;
    const afterOk = end === haystack.length || !isWordChar(haystack.charCodeAt(end));
    if (beforeOk && afterOk) return true;
    from = at + 1;
  }
  return false;
}

function isWordChar(code: number): boolean {
  if (code >= 48 && code <= 57) return true;
  if (code >= 65 && code <= 90) return true;
  if (code >= 97 && code <= 122) return true;
  return code > 127;
}

function normalize(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

function compareText(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function escapeDirectoryField(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\r", "\\r")
    .replaceAll("\n", "\\n");
}
