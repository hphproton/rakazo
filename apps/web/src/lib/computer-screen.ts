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

export type SandViewerConnection = "connected" | "reconnecting" | "stale";

/**
 * Viewer state a human can see without reading the RFB socket: the computer
 * state, the sealed URL's expiry, a screen error, and whether the iframe
 * document has loaded.
 */
export function sandViewerConnection(input: {
  url: string | null;
  state: "stopped" | "booting" | "running" | "suspended" | "error" | undefined;
  screenError: boolean;
  frameLoaded: boolean;
  now?: number;
}): SandViewerConnection {
  const now = input.now ?? Date.now();
  if (input.state === "stopped" || input.state === "suspended" || input.state === "error") {
    return "stale";
  }
  const expires = Number(input.url?.match(NOVNC_CAPABILITY)?.[2]);
  if (Number.isFinite(expires) && expires - now <= 60_000) return "stale";
  if (!input.url || input.state === "booting" || input.screenError || !input.frameLoaded) {
    return "reconnecting";
  }
  return "connected";
}

/**
 * Same sealed capability. The iframe adds reconnect so a dropped RFB socket
 * retries, and show_dot=false so the connection-quality dot stays off.
 * Stock noVNC has no query flag that removes its control bar, and covering
 * that bar would block the desktop.
 */
export function sandViewerFrameUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url, "http://127.0.0.1");
    if (!parsed.pathname.includes("/novnc/session/")) return url;
    parsed.searchParams.set("reconnect", "true");
    parsed.searchParams.set("show_dot", "false");
    if (url.startsWith("/")) return `${parsed.pathname}${parsed.search}${parsed.hash}`;
    return parsed.toString();
  } catch {
    return url;
  }
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
