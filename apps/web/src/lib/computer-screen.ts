export interface ComputerScreenResult {
  url: string | null;
  error: string | null;
}

/** Only the latest request for the visible computer may replace its screen or error. */
export async function loadComputerScreen(options: {
  load: () => Promise<{ url: string | null }>;
  isCurrent: () => boolean;
  commit: (result: ComputerScreenResult) => void;
  fallbackError: string;
}): Promise<string | null> {
  let result: ComputerScreenResult;
  try {
    const screen = await options.load();
    result = { url: screen.url, error: null };
  } catch (error) {
    result = {
      url: null,
      error: error instanceof Error && error.message ? error.message : options.fallbackError,
    };
  }
  if (!options.isCurrent()) return null;
  options.commit(result);
  return result.url;
}

const NOVNC_CAPABILITY = /\/novnc\/session\/(view|control)\/(\d+)\./;

/**
 * Keep a sealed noVNC URL that still has time left so a thread refresh does not
 * change the iframe src. A policy change, a near expiry, or any other URL takes
 * the new value.
 */
export function reuseScreenUrl(
  current: string | null,
  next: string | null,
  now = Date.now(),
): string | null {
  if (!next) return null;
  if (!current) return next;
  const currentMatch = current.match(NOVNC_CAPABILITY);
  const nextMatch = next.match(NOVNC_CAPABILITY);
  if (!currentMatch || !nextMatch) return next;
  if (currentMatch[1] !== nextMatch[1]) return next;
  const expires = Number(currentMatch[2]);
  if (!Number.isFinite(expires) || expires - now <= 60_000) return next;
  return current;
}

export function embeddableScreenUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url, window.location.href);
    const page = new URL(window.location.href);
    const local = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
    const pagePort = page.port || (page.protocol === "https:" ? "443" : "80");
    if (local && parsed.port && parsed.port !== pagePort) {
      return null;
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

export function screenIframeSandbox(url: string | null) {
  if (!url) return undefined;
  try {
    return new URL(url, window.location.href).pathname.startsWith("/novnc/")
      ? "allow-scripts allow-pointer-lock"
      : undefined;
  } catch {
    return undefined;
  }
}
