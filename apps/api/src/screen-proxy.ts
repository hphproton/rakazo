import { timingSafeEqual } from "node:crypto";
import { hasActiveComputerControl } from "@rakazo/adapters";
import type { ScreenCapabilityScope } from "@rakazo/core/node/screen-capability";
import {
  openScreenCapability,
  SCREEN_TARGET_ENDPOINT,
  sealScreenCapability,
} from "@rakazo/core/node/screen-capability";
import type { PrismaClient } from "@rakazo/db";
import type { Hono } from "hono";
import { requestBodyLimit } from "./request-body-limit.js";

const SAND_SCREEN_REUSE_MS = 60_000;
const sandScreenSeals = new Map<string, { url: string; expiresAt: number }>();

export function sandScreenSealKey(input: {
  computerId: string;
  interactive: boolean;
  botGeneration: number;
  computerGeneration: number;
  controlLeaseId: string | null;
  upstream: string;
}): string {
  return [
    input.computerId,
    input.interactive ? "control" : "view",
    input.botGeneration,
    input.computerGeneration,
    input.controlLeaseId ?? "",
    input.upstream,
  ].join("\0");
}

/** Return the sand seal for this seat while it still has time left. */
export function takeSandScreenSeal(key: string, now = Date.now()): string | null {
  const cached = sandScreenSeals.get(key);
  if (!cached) return null;
  if (cached.expiresAt - now <= SAND_SCREEN_REUSE_MS) {
    sandScreenSeals.delete(key);
    return null;
  }
  return cached.url;
}

export function keepSandScreenSeal(key: string, url: string): void {
  const match = url.match(/\/novnc\/session\/(?:view|control)\/(\d+)\./);
  const expiresAt = match ? Number(match[1]) : Number.NaN;
  if (!Number.isFinite(expiresAt)) return;
  sandScreenSeals.set(key, { url, expiresAt });
}

export function addScreenProxyCapability(
  url: string,
  secret: string,
  origin: string,
  scope: ScreenCapabilityScope,
  now = Date.now(),
) {
  // Local/desktop providers return non-http schemes (e.g. desktop://). Those never
  // traverse the web proxy, so seal only http(s) upstream URLs.
  const protocol = new URL(url).protocol;
  if (protocol !== "http:" && protocol !== "https:") return url;
  return sealScreenCapability(url, secret, origin, scope, now);
}

export function mountScreenTarget(app: Hono, prisma: PrismaClient, secret: string) {
  app.post(SCREEN_TARGET_ENDPOINT, requestBodyLimit(16 * 1024), async (c) => {
    c.header("cache-control", "no-store");
    const supplied = Buffer.from(c.req.header("authorization") ?? "");
    const expected = Buffer.from(`Bearer ${secret}`);
    if (!secret || supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
      return c.body(null, 403);
    const body = await c.req.json().catch(() => null);
    if (typeof body?.path !== "string") return c.body(null, 403);
    const capability = openScreenCapability(body.path, secret);
    if (!capability) return c.body(null, 403);
    const { scope, target } = capability;
    const bot = await prisma.bot.findFirst({
      where: {
        id: scope.botId,
        computerId: scope.computerId,
        archivedAt: null,
        screenGeneration: scope.botGeneration,
      },
      select: {
        computer: {
          select: {
            screenGeneration: true,
            providerRef: true,
            state: true,
            controlHolder: true,
            controlLeaseId: true,
            controlBotId: true,
            controlLeaseExpiresAt: true,
          },
        },
      },
    });
    const computer = bot?.computer;
    if (
      !computer ||
      computer.screenGeneration !== scope.computerGeneration ||
      !computer.providerRef ||
      !["running", "booting"].includes(computer.state) ||
      (target.interactive &&
        (!hasActiveComputerControl(computer) ||
          !scope.controlLeaseId ||
          computer.controlLeaseId !== scope.controlLeaseId ||
          computer.controlBotId !== scope.botId))
    )
      return c.body(null, 403);
    return c.json(target);
  });
}
