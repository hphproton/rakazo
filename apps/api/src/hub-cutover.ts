import { ORPCError } from "@orpc/server";
import type { JobPublisher } from "@rakazo/adapter-kit";
import type { Actor, BotMessageIntent } from "@rakazo/contracts";
import {
  HUB_INBOUND_CUTOVER_ERROR,
  HUB_INBOUND_PROCEDURE,
  hubInboundCall,
  isHubInboundEnvelope,
  RAKAZO_TO_HUB_PATH,
} from "@rakazo/core";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { receiveHubMessage } from "./hub-inbound.js";
import type { ThreadTarget } from "./thread-target.js";

/**
 * The only Hub → Rakazo entry the router should call. It always lands on
 * threads/receiveHub, on a bot thread or a ChatGroup thread. Rakazo → Hub
 * stays MCP and is not invoked here.
 */
export async function deliverHubInbound(
  deps: {
    prisma: PrismaClient;
    events: Pick<ThreadEvents, "notify">;
    jobs: Pick<JobPublisher, "enqueue">;
  },
  actor: Actor,
  target: ThreadTarget,
  input: {
    hubAgentId: string;
    hubAgentName: string;
    text: string;
    intent?: BotMessageIntent;
    clientNonce?: string;
    spaceTopicKey?: string;
  },
) {
  if (target.kind === "group") {
    return receiveHubMessage(deps, actor, target, input);
  }
  const route = hubInboundCall({
    botId: target.botId,
    hubAgentId: input.hubAgentId,
    hubAgentName: input.hubAgentName,
    text: input.text,
    intent: input.intent,
    clientNonce: input.clientNonce,
    ...(input.spaceTopicKey ? { spaceTopicKey: input.spaceTopicKey } : {}),
  });
  if (route.procedure !== HUB_INBOUND_PROCEDURE) {
    throw new ORPCError("BAD_REQUEST", { message: HUB_INBOUND_CUTOVER_ERROR });
  }
  return receiveHubMessage(deps, actor, target, {
    hubAgentId: route.input.hubAgentId,
    hubAgentName: route.input.hubAgentName,
    text: route.input.text,
    intent: route.input.intent,
    clientNonce: route.input.clientNonce,
    ...(route.input.spaceTopicKey ? { spaceTopicKey: route.input.spaceTopicKey } : {}),
  });
}

/** Refuse a webhook that is shaped like a Hub delivery so it cannot land as a user bubble. */
export function hubWebhookCutover(payload: Record<string, unknown>): {
  status: 409;
  body: {
    error: typeof HUB_INBOUND_CUTOVER_ERROR;
    procedure: typeof HUB_INBOUND_PROCEDURE;
    rakazoToHub: typeof RAKAZO_TO_HUB_PATH;
  };
} | null {
  if (!isHubInboundEnvelope(payload)) return null;
  return {
    status: 409,
    body: {
      error: HUB_INBOUND_CUTOVER_ERROR,
      procedure: HUB_INBOUND_PROCEDURE,
      rakazoToHub: RAKAZO_TO_HUB_PATH,
    },
  };
}
