import { Trans, useLingui } from "@lingui/react/macro";
import type { ComputerStatus } from "@rakazo/contracts";
import { Button } from "@rakazo/ui-web";
import { X } from "lucide-react";
import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from "react";
import {
  SAND_SCREEN_HEIGHT,
  SAND_SCREEN_WIDTH,
  type SandViewerConnection,
  sandScreenFrameSize,
  sandScreenSocketUrl,
  sandScreenViewOnly,
  sandViewerConnection,
} from "../../lib/computer-screen";

/**
 * Full sand viewer. Mounted only while the computer overlay is open. The
 * picture is an in-app RFB client on the sealed websockify path. Closing
 * unmounts this shell and disconnects that client. Stock noVNC stays unused.
 */
export function SandScreenShell({
  botName,
  url,
  state,
  screenError,
  screenWidth = SAND_SCREEN_WIDTH,
  screenHeight = SAND_SCREEN_HEIGHT,
  fallback,
  onClose,
  frameStyle,
}: {
  botName: string;
  url: string | null;
  state: ComputerStatus["state"] | undefined;
  screenError: boolean;
  screenWidth?: number;
  screenHeight?: number;
  fallback?: ReactNode;
  onClose?: () => void;
  frameStyle?: CSSProperties;
}) {
  const { t } = useLingui();
  const [live, setLive] = useState(false);
  const connection = sandViewerConnection({ url, state, screenError, live });
  const quiet = screenError || state === "stopped" || state === "suspended" || state === "error";
  const showFrame = Boolean(url) && !quiet;

  return (
    <section
      data-testid="sand-screen-shell"
      aria-label={botName}
      className="fixed inset-x-0 top-0 z-30 flex flex-col bg-background"
      style={frameStyle}
    >
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-4">
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground" dir="auto">
          {botName}
        </span>
        <span className="shrink-0 text-sm text-muted-foreground">
          {connectionLabel(connection)}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="text-muted-foreground"
          aria-label={t`Close computer`}
          onClick={onClose}
        >
          <X size={16} strokeWidth={1.8} />
        </Button>
      </header>
      <div data-testid="sand-screen-viewport" className="relative min-h-0 flex-1 bg-black">
        <div className="absolute inset-0">
          {showFrame && url ? (
            <SandScreenFrame
              url={url}
              screenWidth={screenWidth}
              screenHeight={screenHeight}
              onLive={setLive}
            />
          ) : (
            <div className="grid h-full place-items-center text-sm text-muted-foreground">
              {fallback}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function SandScreenFrame({
  url,
  screenWidth,
  screenHeight,
  onLive,
}: {
  url: string;
  screenWidth: number;
  screenHeight: number;
  onLive: (live: boolean) => void;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const onLiveRef = useRef(onLive);
  onLiveRef.current = onLive;
  const [container, setContainer] = useState({ width: 0, height: 0 });
  const frame = sandScreenFrameSize({
    containerWidth: container.width,
    containerHeight: container.height,
    screenWidth,
    screenHeight,
  });

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (!rect) return;
      setContainer({ width: rect.width, height: rect.height });
    });
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    const socketUrl = sandScreenSocketUrl(url, window.location.href);
    if (!host || !socketUrl) {
      onLiveRef.current(false);
      return;
    }
    let stopped = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let client: { disconnect: () => void } | null = null;

    const connect = async () => {
      if (stopped) return;
      const { default: RFB } = await import("@novnc/novnc");
      if (stopped || !hostRef.current) return;
      const previous = client;
      const next = new RFB(hostRef.current, socketUrl, { shared: true });
      next.viewOnly = sandScreenViewOnly(url);
      next.scaleViewport = true;
      next.resizeSession = false;
      next.background = "black";
      next.addEventListener("connect", () => {
        if (!stopped) onLiveRef.current(true);
      });
      next.addEventListener("disconnect", () => {
        if (stopped || client !== next) return;
        onLiveRef.current(false);
        retry = setTimeout(() => void connect(), 1_000);
      });
      client = next;
      previous?.disconnect();
    };

    void connect();
    return () => {
      stopped = true;
      if (retry) clearTimeout(retry);
      onLiveRef.current(false);
      client?.disconnect();
    };
  }, [url]);

  return (
    <div
      ref={stageRef}
      data-testid="sand-screen-stage"
      className="grid h-full w-full place-items-center bg-black"
    >
      <div
        ref={hostRef}
        data-testid="sand-screen-frame"
        style={{ width: frame.width, height: frame.height }}
      />
    </div>
  );
}

function connectionLabel(connection: SandViewerConnection) {
  if (connection === "connected") return <Trans>Connected</Trans>;
  if (connection === "stale") return <Trans>Stale</Trans>;
  return <Trans>Reconnecting</Trans>;
}
