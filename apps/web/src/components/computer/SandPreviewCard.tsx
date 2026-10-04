import { Trans, useLingui } from "@lingui/react/macro";
import type { ComputerStatus } from "@rakazo/contracts";
import { Maximize2 } from "lucide-react";
import type { ReactNode } from "react";
import { computerPlaceholder } from "../../lib/computer-placeholder";

/**
 * Collapsed sand sidebar card. Same interaction as the stock computer preview:
 * a 16/10 stage, and a tap or click opens the full view. No RFB client lives
 * here. The picture is the computer label, or the real stopped/asleep/failed
 * state — never a connection word.
 */
export function SandPreviewCard({
  open,
  state,
  booting,
  label,
  caption,
  screenError,
  onOpen,
}: {
  open: boolean;
  state: ComputerStatus["state"] | undefined;
  booting: boolean;
  label: string;
  caption: string;
  screenError: ReactNode;
  onOpen: () => void;
}) {
  const { t } = useLingui();
  return (
    <>
      <div
        data-testid="computer-preview"
        className="group relative aspect-[16/10] overflow-hidden rounded-[14px] bg-background"
      >
        {open ? (
          <div className="grid h-full place-items-center text-sm text-muted-foreground/80">
            <Trans>Open in full window</Trans>
          </div>
        ) : (
          <div className="grid h-full place-items-center px-6 text-center text-sm text-muted-foreground/80">
            {screenError ?? computerPlaceholder(state, booting, label)}
          </div>
        )}
        {!screenError ? (
          <button
            type="button"
            data-testid="computer-preview-open"
            className="absolute inset-0 flex cursor-pointer items-center justify-center bg-overlay/40 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
            aria-label={t`Open`}
            onClick={onOpen}
          >
            <span className="inline-flex items-center gap-2 rounded-full bg-overlay px-3.5 py-2 text-[14px] text-foreground shadow-md">
              <Maximize2 size={15} strokeWidth={1.9} aria-hidden />
              <Trans>Open</Trans>
            </span>
          </button>
        ) : null}
      </div>
      <p className="mt-2 truncate text-[13.5px] text-muted-foreground" dir="auto">
        {caption}
      </p>
    </>
  );
}
