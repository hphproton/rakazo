import type RFB from "@novnc/novnc";
import type { ComputerStatus } from "@rakazo/contracts";
import { useEffect, useRef } from "react";
import {
  sandScreenSocketUrl,
  sandScreenViewOnly,
  screenIframeSandbox,
} from "../../lib/computer-screen";

/** Delay before another attempt while this frame is still mounted. */
export const SAND_SCREEN_RETRY_MS = 1_000;
/** A socket that never finishes the handshake is dropped and tried again. */
export const SAND_SCREEN_CONNECT_MS = 8_000;

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
 * connects again while this frame stays mounted; unmount cancels that timer.
 * A running seat with no stream is not described here.
 */
export function ComputerLiveScreen({
  kind,
  url,
  title,
  allow,
  pointerEvents,
}: {
  kind: ComputerStatus["kind"] | undefined;
  url: string;
  title: string;
  allow: string;
  pointerEvents: "none" | "auto";
}) {
  if (liveScreenIsInAppRfb(kind)) {
    return <SandScreenFrame url={url} title={title} pointerEvents={pointerEvents} />;
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
}: {
  url: string;
  title: string;
  pointerEvents: "none" | "auto";
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const clientRef = useRef<RFB | null>(null);
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
    const schedule = () => {
      if (stopped || retry !== undefined) return;
      retry = window.setTimeout(() => {
        retry = undefined;
        connect();
      }, SAND_SCREEN_RETRY_MS);
    };
    const drop = (next: RFB) => {
      if (stopped || client !== next) return;
      clearConnectTimer();
      client = null;
      clientRef.current = null;
      schedule();
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
            drop(next);
          }, SAND_SCREEN_CONNECT_MS);
          next.addEventListener("connect", () => {
            clearConnectTimer();
            if (host.getBoundingClientRect().width > 0) next.scaleViewport = true;
          });
          next.addEventListener("disconnect", () => {
            drop(next);
          });
        })
        .catch(() => {
          schedule();
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
      clearConnectTimer();
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
