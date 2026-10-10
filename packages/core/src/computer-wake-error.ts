/** A failed wake stays with its bot until the next wake starts or one succeeds. */
export type ComputerWakeErrors = ReadonlyMap<string, string>;

export function rememberComputerWakeError(
  errors: ComputerWakeErrors,
  botId: string,
  message: string,
): ComputerWakeErrors {
  const next = new Map(errors);
  next.set(botId, message);
  return next;
}

export function clearComputerWakeError(
  errors: ComputerWakeErrors,
  botId: string,
): ComputerWakeErrors {
  if (!errors.has(botId)) return errors;
  const next = new Map(errors);
  next.delete(botId);
  return next;
}

/**
 * The stored failure is shown while the desktop is stopped, suspended, or in
 * error. Running and booting hide it. A status refresh does not change the map.
 */
export function visibleComputerWakeError(
  errors: ComputerWakeErrors,
  botId: string | null | undefined,
  state: string | null | undefined,
): string | null {
  if (!botId) return null;
  if (state === "running" || state === "booting") return null;
  const message = errors.get(botId);
  return message ? message : null;
}
