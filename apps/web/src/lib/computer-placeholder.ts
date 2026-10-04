import { t } from "@lingui/core/macro";
import type { ComputerStatus } from "@rakazo/contracts";

/**
 * Empty-stage copy for a computer preview.
 *
 * On Grok Computer, stop-window / suspend / seat stop is a real control: the
 * desktop/seat is off (or stopped). UI may show that the computer is
 * stopped or asleep. That is not the same as a human RFB stream that is
 * disconnected while the seat is still running (lazy viewer or a closed
 * panel).
 *
 * stopped / suspended / error → desktop off, using the existing preview sentences.
 * running keeps the computer label. Do not invent an Idle row for a live seat.
 */
export function computerPlaceholder(
  state: ComputerStatus["state"] | undefined,
  booting: boolean,
  label: string,
) {
  if (state === "booting" || booting) return t`Booting live desktop…`;
  if (state === "running") return label;
  if (state === "suspended") return t`Computer is asleep. Open it to wake.`;
  if (state === "error") return t`Computer failed to boot`;
  return t`Computer is stopped`;
}
