import { createHmac, timingSafeEqual } from "node:crypto";
import type { HubDirectory } from "@rakazo/core";
import { canonicalHubDirectoryBody } from "@rakazo/core";

export function signHubDirectory(directory: HubDirectory, key: string): string {
  return createHmac("sha256", key).update(canonicalHubDirectoryBody(directory)).digest("hex");
}

export function verifyHubDirectorySignature(
  directory: HubDirectory,
  key: string,
  signature: string,
): boolean {
  const expected = signHubDirectory(directory, key);
  const left = Buffer.from(expected);
  const right = Buffer.from(signature);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function withHubDirectorySignature<T extends HubDirectory>(
  directory: T,
  signingKey: string | undefined,
): T & { signature: string | null } {
  return {
    ...directory,
    signature: signingKey ? signHubDirectory(directory, signingKey) : null,
  };
}
