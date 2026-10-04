import type RFB from "@novnc/novnc";
import type { ComputerStatus } from "@rakazo/contracts";
import { useEffect, useRef } from "react";
import {
  sandScreenSocketUrl,
  sandScreenViewOnly,
  screenIframeSandbox,
} from "../../lib/computer-screen";

/** One delayed retry after an unexpected drop. A second drop does not schedule another. */
export const SAND_SCREEN_RETRY_MS = 1_000;

const FRAME_CLASS = "h-full w-full border-0 bg-black";

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
 * cannot reload a viewer document. An unexpected drop retries once; unmount
 * cancels that timer. A running seat with no stream is not described here.
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
    let retried = false;

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
          next.addEventListener("disconnect", (event) => {
            if (stopped || client !== next) return;
            client = null;
            clientRef.current = null;
            const detail = (event as CustomEvent<{ clean?: boolean }>).detail;
            if (detail?.clean !== false || retried) return;
            retried = true;
            retry = window.setTimeout(connect, SAND_SCREEN_RETRY_MS);
          });
        })
        .catch(() => {
          if (stopped || retried) return;
          retried = true;
          retry = window.setTimeout(connect, SAND_SCREEN_RETRY_MS);
        });
    };

    connect();
    return () => {
      stopped = true;
      if (retry !== undefined) window.clearTimeout(retry);
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
      className={FRAME_CLASS}
      style={{ pointerEvents }}
    />
  );
}
