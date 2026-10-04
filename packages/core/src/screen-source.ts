/** Re-read `computer/screenUrl` this long after the last successful seal. */
export const SCREEN_URL_RENEW_MS = 50 * 60_000;

/**
 * Identity of a live screen stream, ignoring rotating capability tokens.
 * View vs control stays in the key so takeover/release still reconnects.
 */
export function screenStreamKey(url: string): string {
  try {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/^\/novnc\/session\/(view|control)\/[^/]+(\/.*)?$/);
    if (match) return `${parsed.origin}/novnc/session/${match[1]}${match[2] ?? ""}`;
    const viewOnly = parsed.searchParams.get("view_only");
    const policy = viewOnly == null ? "" : `?view_only=${viewOnly}`;
    return `${parsed.origin}${parsed.pathname}${policy}`;
  } catch {
    return url;
  }
}

/**
 * Remaining life at which a same-stream capability is replaced.
 * Sealed URLs live one hour; the refresher re-reads at `SCREEN_URL_RENEW_MS`.
 * Slack covers clock and timer skew so that fetch is applied before expiry.
 */
const SCREEN_CAPABILITY_TTL_MS = 60 * 60_000;
const SCREEN_SOURCE_RENEW_REMAINING_MS =
  SCREEN_CAPABILITY_TTL_MS - SCREEN_URL_RENEW_MS + 5 * 60_000;

function screenCapabilityExpiresAt(url: string): number | null {
  try {
    const match = new URL(url).pathname.match(/^\/novnc\/session\/(?:view|control)\/(\d+)\./);
    if (!match) return null;
    const expiresAt = Number(match[1]);
    return Number.isSafeInteger(expiresAt) ? expiresAt : null;
  } catch {
    return null;
  }
}

/**
 * Keep the connected screen URL while only the capability token rotated.
 * Adopt a newer same-stream URL once the held capability is in the renew window,
 * so the proxy does not close the live stream when the original token expires.
 */
export function retainScreenSource(held: string, next: string, now = Date.now()): string {
  if (screenStreamKey(held) !== screenStreamKey(next)) return next;
  const heldExpires = screenCapabilityExpiresAt(held);
  const nextExpires = screenCapabilityExpiresAt(next);
  if (
    heldExpires != null &&
    nextExpires != null &&
    nextExpires > heldExpires &&
    heldExpires - now <= SCREEN_SOURCE_RENEW_REMAINING_MS
  ) {
    return next;
  }
  return held;
}
