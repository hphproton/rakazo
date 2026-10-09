import { redactSecrets } from "@rakazo/core";

/**
 * Copy of a run failure safe to put on a server log. The user-facing message
 * stays a separate redacted string. Name and cause are what make the next
 * abort attributable.
 */
export function redactFailure(error: unknown, secrets: string[], seen = new Set<unknown>()): Error {
  if (!(error instanceof Error)) {
    const plain = new Error(redactSecrets(String(error), secrets));
    plain.name = "Error";
    return plain;
  }
  if (seen.has(error)) {
    const circular = new Error("[Circular]");
    circular.name = error.name || "Error";
    return circular;
  }
  seen.add(error);
  const copy = new Error(redactSecrets(error.message, secrets));
  copy.name = error.name || "Error";
  if (error.stack) copy.stack = redactSecrets(error.stack, secrets);
  if (error.cause !== undefined) copy.cause = redactFailure(error.cause, secrets, seen);
  return copy;
}
