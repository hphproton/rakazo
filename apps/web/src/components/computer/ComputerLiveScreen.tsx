import type RFB from "@novnc/novnc";
import type { ComputerStatus } from "@rakazo/contracts";
import { useEffect, useRef } from "react";
import {
  sandScreenSocketUrl,
  sandScreenViewOnly,
  screenIframeSandbox,
} from "../../lib/computer-screen";

/** First wait before trying the same seal again after a refetch leaves it in place. */
export const SAND_SCREEN_RETRY_MS = 1_000;
/** Cap for that wait. A dead seal must not be opened every second. */
export const SAND_SCREEN_RETRY_MAX_MS = 60_000;
/** A socket that never finishes the handshake is dropped. */
export const SAND_SCREEN_CONNECT_MS = 8_000;

/** Backoff after a refetch that did not change the seal. Attempt 1 waits `SAND_SCREEN_RETRY_MS`. */
export function sandScreenRetryDelay(attempt: number) {
  const step = Math.min(Math.max(attempt, 1) - 1, 6);
  return Math.min(SAND_SCREEN_RETRY_MAX_MS, SAND_SCREEN_RETRY_MS * 2 ** step);
}

const FRAME_CLASS = "h-full w-full border-0 bg-black";
/**
 * Pin the frame to the preview card. The card sizes with aspect-ratio and its
 * other child is the absolute open button, so the RFB client measures this box.
 */
const SAND_FRAME_CLASS = "absolute inset-0 overflow-hidden border-0 bg-black";

export function liveScreenIsInAppRfb(kind: ComputerStatus["kind"] | undefined) {
  return kind === "sand";
}

/**
 * The picture inside the stock computer preview and overlay.
 * Sand uses an in-app RFB client on the sealed websockify path.
 * Every other kind keeps the stock iframe, including its vnc.html document.
 *
 * The sand client connects once per socket. A render that repeats the same
 * sealed URL does not reconnect. vnc.html is not loaded, so a thread refresh
 * cannot reload a viewer document. A drop or a handshake that never finishes
 * asks for a fresh seal. The same seal is retried with backoff, and only while
 * the document is visible. Unmount or hiding the document cancels that wait.
 * A running seat with no stream is not described here.
 */
export function ComputerLiveScreen({
  kind,
  url,
  title,
  allow,
  pointerEvents,
  onRejected,
}: {
  kind: ComputerStatus["kind"] | undefined;
  url: string;
  title: string;
  allow: string;
  pointerEvents: "none" | "auto";
  /** Read a new screen URL after this socket dies. A hidden document does not call it. */
  onRejected?: () => unknown;
}) {
  if (liveScreenIsInAppRfb(kind)) {
    return (
      <SandScreenFrame
        url={url}
        title={title}
        pointerEvents={pointerEvents}
        onRejected={onRejected}
      />
    );
  }
  return (
    <iframe
      title={title}
      src={url}
      sandbox={screenIframeSandbox(url)}
      className={FRAME_CLASS}
      allow={allow}
      style={{ pointerEvents }}
    />
  );
}

function SandScreenFrame({
  url,
  title,
  pointerEvents,
  onRejected,
}: {
  url: string;
  title: string;
  pointerEvents: "none" | "auto";
  onRejected?: () => unknown;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const clientRef = useRef<RFB | null>(null);
  const onRejectedRef = useRef(onRejected);
  onRejectedRef.current = onRejected;
  const viewOnly = sandScreenViewOnly(url, pointerEvents === "auto");
  const viewOnlyRef = useRef(viewOnly);
  viewOnlyRef.current = viewOnly;
  const socketUrl = sandScreenSocketUrl(
    url,
    typeof window === "undefined" ? "http://127.0.0.1/" : window.location.href,
  );

  useEffect(() => {
    const client = clientRef.current;
    if (!client) return;
    client.viewOnly = viewOnly;
    client.focusOnClick = !viewOnly;
  }, [viewOnly]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !socketUrl) return;
    let stopped = false;
    let client: RFB | null = null;
    let retry: number | undefined;
    let connectTimer: number | undefined;

    const clearConnectTimer = () => {
      if (connectTimer === undefined) return;
      window.clearTimeout(connectTimer);
      connectTimer = undefined;
    };
    let attempt = 0;
    let recovery = 0;
    let hiddenListener: (() => void) | undefined;
    const clearHidden = () => {
      if (!hiddenListener) return;
      document.removeEventListener("visibilitychange", hiddenListener);
      hiddenListener = undefined;
    };
    const release = (next: RFB) => {
      if (stopped || client !== next) return;
      clearConnectTimer();
      client = null;
      clientRef.current = null;
      beginRecovery();
    };
    const beginRecovery = () => {
      if (stopped) return;
      const token = ++recovery;
      clearHidden();
      if (retry !== undefined) {
        window.clearTimeout(retry);
        retry = undefined;
      }
      const waitUntilVisible = () => {
        if (stopped || token !== recovery) return;
        if (!document.hidden) {
          void recover();
          return;
        }
        const onVisible = () => {
          if (document.visibilityState === "hidden") return;
          clearHidden();
          if (!stopped && token === recovery) void recover();
        };
        hiddenListener = onVisible;
        document.addEventListener("visibilitychange", onVisible);
      };
      const recover = async () => {
        if (stopped || token !== recovery) return;
        if (document.hidden) {
          waitUntilVisible();
          return;
        }
        attempt += 1;
        const delay = sandScreenRetryDelay(attempt);
        try {
          await onRejectedRef.current?.();
        } catch {
          // A failed read leaves the current seal. The backoff below still applies.
        }
        if (stopped || token !== recovery) return;
        if (document.hidden) {
          waitUntilVisible();
          return;
        }
        retry = window.setTimeout(() => {
          retry = undefined;
          if (!stopped && token === recovery) connect();
        }, delay);
      };
      waitUntilVisible();
    };
    const connect = () => {
      if (stopped || client) return;
      void import("@novnc/novnc")
        .then(({ default: RFBClient }) => {
          if (stopped || client || hostRef.current !== host) return;
          const next = new RFBClient(host, socketUrl, { shared: true });
          next.viewOnly = viewOnlyRef.current;
          next.scaleViewport = true;
          next.resizeSession = false;
          next.background = "black";
          next.focusOnClick = !viewOnlyRef.current;
          client = next;
          clientRef.current = next;
          connectTimer = window.setTimeout(() => {
            connectTimer = undefined;
            if (stopped || client !== next) return;
            try {
              next.disconnect();
            } catch {
              // A half-open client can throw while tearing down.
            }
            release(next);
          }, SAND_SCREEN_CONNECT_MS);
          next.addEventListener("connect", () => {
            clearConnectTimer();
            attempt = 0;
            if (host.getBoundingClientRect().width > 0) next.scaleViewport = true;
          });
          next.addEventListener("disconnect", () => {
            release(next);
          });
        })
        .catch(() => {
          beginRecovery();
        });
    };

    let seenWidth = 0;
    let seenHeight = 0;
    const resize =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(() => {
            const current = clientRef.current;
            const box = host.getBoundingClientRect();
            const width = Math.round(box.width);
            const height = Math.round(box.height);
            if (!current || width < 1 || height < 1) return;
            if (width === seenWidth && height === seenHeight) return;
            seenWidth = width;
            seenHeight = height;
            current.scaleViewport = true;
          });
    resize?.observe(host);
    connect();
    return () => {
      stopped = true;
      recovery += 1;
      clearConnectTimer();
      clearHidden();
      if (retry !== undefined) window.clearTimeout(retry);
      resize?.disconnect();
      const current = client;
      client = null;
      clientRef.current = null;
      current?.disconnect();
    };
  }, [socketUrl]);

  return (
    <div
      ref={hostRef}
      data-testid="sand-screen-frame"
      role="img"
      aria-label={title}
      className={SAND_FRAME_CLASS}
      style={{ pointerEvents }}
    />
  );
}
