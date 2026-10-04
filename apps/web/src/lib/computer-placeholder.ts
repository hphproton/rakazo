import { t } from "@lingui/core/macro";
import type { ComputerStatus } from "@rakazo/contracts";

/**
 * Empty-stage copy for a computer preview. A running seat keeps its label.
 * Stopped, asleep, and failed wording is only for those states.
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
