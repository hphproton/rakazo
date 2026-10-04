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

/** Seat desktop used when a sand computer has not reported its own size. */
export const SAND_SCREEN_WIDTH = 1280;
export const SAND_SCREEN_HEIGHT = 800;

/**
 * Viewer state from the computer, the sealed URL's expiry, a screen error,
 * and whether the in-app RFB socket is up.
 */
export function sandViewerConnection(input: {
  url: string | null;
  state: "stopped" | "booting" | "running" | "suspended" | "error" | undefined;
  screenError: boolean;
  live: boolean;
  now?: number;
}): SandViewerConnection {
  const now = input.now ?? Date.now();
  if (input.state === "stopped" || input.state === "suspended" || input.state === "error") {
    return "stale";
  }
  const expires = Number(input.url?.match(NOVNC_CAPABILITY)?.[2]);
  if (Number.isFinite(expires) && expires - now <= 60_000) return "stale";
  if (!input.url || input.state === "booting" || input.screenError || !input.live) {
    return "reconnecting";
  }
  return "connected";
}

/** The sealed page's websockify path, on the same origin, as a WebSocket URL. */
export function sandScreenSocketUrl(screenUrl: string | null, base: string): string | null {
  if (!screenUrl) return null;
  try {
    const page = new URL(screenUrl, base);
    if (page.protocol !== "http:" && page.protocol !== "https:") return null;
    if (!page.pathname.includes("/novnc/session/")) return null;
    const pathParam = page.searchParams.get("path");
    const socket = pathParam ? new URL(pathParam, page) : new URL("websockify", page);
    if (socket.origin !== page.origin) return null;
    if (!socket.pathname.endsWith("/websockify")) return null;
    socket.protocol = page.protocol === "https:" ? "wss:" : "ws:";
    return socket.toString();
  } catch {
    return null;
  }
}

/** View unless the sealed capability explicitly allows control. */
export function sandScreenViewOnly(screenUrl: string | null): boolean {
  if (!screenUrl) return true;
  try {
    return new URL(screenUrl, "http://127.0.0.1").searchParams.get("view_only") !== "false";
  } catch {
    return true;
  }
}

/**
 * Largest box of the desktop's aspect ratio that fits the container.
 * A matching ratio fills the container. Any other ratio letterboxes.
 */
export function sandScreenFrameSize(input: {
  containerWidth: number;
  containerHeight: number;
  screenWidth?: number;
  screenHeight?: number;
}): { width: number; height: number } {
  const screenWidth = positiveSize(input.screenWidth) ?? SAND_SCREEN_WIDTH;
  const screenHeight = positiveSize(input.screenHeight) ?? SAND_SCREEN_HEIGHT;
  if (input.containerWidth <= 0 || input.containerHeight <= 0) return { width: 0, height: 0 };
  const scale = Math.min(input.containerWidth / screenWidth, input.containerHeight / screenHeight);
  return {
    width: fittedEdge(screenWidth * scale, input.containerWidth),
    height: fittedEdge(screenHeight * scale, input.containerHeight),
  };
}

/** Fill the container when rounding leaves less than a pixel of bar. */
function fittedEdge(scaled: number, container: number) {
  if (container - scaled < 1) return container;
  return Math.floor(scaled);
}

function positiveSize(value: number | undefined) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
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
