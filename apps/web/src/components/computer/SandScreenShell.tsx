import { Trans, useLingui } from "@lingui/react/macro";
import type { ComputerStatus } from "@rakazo/contracts";
import { Button } from "@rakazo/ui-web";
import { X } from "lucide-react";
import { type CSSProperties, type ReactNode, useEffect, useState } from "react";
import {
  type SandViewerConnection,
  sandViewerConnection,
  sandViewerFrameUrl,
  screenIframeSandbox,
} from "../../lib/computer-screen";

/**
 * Human viewer for a sand screen. The iframe keeps the sealed noVNC URL.
 * Stock computer controls stay on other providers.
 */
export function SandScreenShell({
  variant,
  botName,
  url,
  state,
  screenError,
  fallback,
  onClose,
  frameStyle,
}: {
  variant: "overlay" | "panel";
  botName: string;
  url: string | null;
  state: ComputerStatus["state"] | undefined;
  screenError: boolean;
  fallback?: ReactNode;
  onClose?: () => void;
  frameStyle?: CSSProperties;
}) {
  const { t } = useLingui();
  const [frameLoaded, setFrameLoaded] = useState(false);
  useEffect(() => {
    setFrameLoaded(false);
  }, [url]);
  const connection = sandViewerConnection({ url, state, screenError, frameLoaded });
  const frameUrl = sandViewerFrameUrl(url);
  const quiet = screenError || state === "stopped" || state === "suspended" || state === "error";
  const showFrame = Boolean(frameUrl) && !quiet;

  async function copyLink() {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      // The button stays available. The sealed URL is already on the iframe.
    }
  }

  function openFull() {
    if (!url) return;
    window.open(url, "_blank", "noopener,noreferrer");
  }

  return (
    <section
      data-testid="sand-screen-shell"
      aria-label={botName}
      className={
        variant === "overlay"
          ? "fixed inset-x-0 top-0 z-30 flex flex-col bg-background"
          : "mb-4 flex h-[70vh] min-h-80 flex-col overflow-hidden rounded-[14px] border border-border bg-background"
      }
      style={variant === "overlay" ? frameStyle : undefined}
    >
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-4">
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground" dir="auto">
          {botName}
        </span>
        <span className="shrink-0 text-sm text-muted-foreground">
          {connectionLabel(connection)}
        </span>
        <Button type="button" variant="ghost" size="sm" disabled={!url} onClick={openFull}>
          <Trans>Open full</Trans>
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={!url}
          onClick={() => void copyLink()}
        >
          <Trans>Copy link</Trans>
        </Button>
        {variant === "overlay" ? (
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
        ) : null}
      </header>
      <div className="relative min-h-0 flex-1 bg-black">
        {showFrame ? (
          <iframe
            title={t`Bot screen`}
            src={frameUrl ?? undefined}
            sandbox={screenIframeSandbox(frameUrl)}
            className="h-full w-full border-0 bg-black"
            allow="clipboard-read; clipboard-write; fullscreen"
            onLoad={() => setFrameLoaded(true)}
          />
        ) : (
          <div className="grid h-full place-items-center text-sm text-muted-foreground">
            {fallback}
          </div>
        )}
      </div>
    </section>
  );
}

function connectionLabel(connection: SandViewerConnection) {
  if (connection === "connected") return <Trans>Connected</Trans>;
  if (connection === "stale") return <Trans>Stale</Trans>;
  return <Trans>Reconnecting</Trans>;
}
