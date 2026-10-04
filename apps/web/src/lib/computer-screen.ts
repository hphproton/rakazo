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

const SEALED_SESSION = /^(\/novnc\/session\/(?:view|control)\/[^/]+)(?:\/|$)/;

/**
 * WebSocket for an in-app RFB client. The sealed page and this socket share
 * one capability directory, the same directory the terminal socket uses.
 * A path query that leaves that directory is ignored. The provider token
 * stays inside the capability and is not copied onto the socket.
 */
export function sandScreenSocketUrl(screenUrl: string | null, base: string): string | null {
  if (!screenUrl) return null;
  let page: URL;
  try {
    page = new URL(screenUrl, base);
  } catch {
    return null;
  }
  if (page.protocol !== "http:" && page.protocol !== "https:") return null;
  const session = page.pathname.match(SEALED_SESSION);
  if (!session) return null;
  const directory = `${session[1]}/`;
  const sibling = new URL("websockify", new URL(directory, page));
  let socket = sibling;
  const pathParam = page.searchParams.get("path");
  if (pathParam) {
    try {
      const requested = new URL(pathParam, page);
      if (
        requested.origin === page.origin &&
        requested.pathname.startsWith(directory) &&
        requested.pathname.endsWith("/websockify")
      ) {
        socket = requested;
      }
    } catch {
      socket = sibling;
    }
  }
  socket.protocol = page.protocol === "https:" ? "wss:" : "ws:";
  socket.search = "";
  socket.hash = "";
  return socket.toString();
}

/** View-only unless the sealed capability allows control and the surface is interactive. */
export function sandScreenViewOnly(screenUrl: string, interactive: boolean): boolean {
  if (!interactive) return true;
  try {
    return new URL(screenUrl, "http://127.0.0.1").searchParams.get("view_only") !== "false";
  } catch {
    return true;
  }
}
