import type { MessageBlock } from "@rakazo/contracts";
import { cloudAgentBlockFromPayload } from "./cloud-agent.js";

/** Computer-card state while a takeover is still waiting on the user. */
export const TAKEOVER_COMPUTER_PENDING_STATE = "Needs you";

/** Computer-card state once takeover release or resume has returned control. */
export const TAKEOVER_COMPUTER_RELEASED_STATE = "Ready";

/**
 * Settle a pending takeover computer card. Returns null when no block is pending,
 * so a second release or resume does not write the message again.
 */
export function releasedTakeoverComputerBlocks(
  blocks: readonly MessageBlock[],
): MessageBlock[] | null {
  let changed = false;
  const next = blocks.map((block) => {
    if (block.kind !== "computer" || block.state !== TAKEOVER_COMPUTER_PENDING_STATE) return block;
    changed = true;
    return { ...block, state: TAKEOVER_COMPUTER_RELEASED_STATE };
  });
  return changed ? next : null;
}

/** Remove this run's live message and obsolete unscoped progress without reordering history. */
export function takeLiveMessage<Message extends { id: string; runId?: string | null }>(
  messages: readonly Message[],
  liveId: string,
): { previous: Message | undefined; remaining: Message[] } {
  let previous: Message | undefined;
  const remaining: Message[] = [];
  for (const message of messages) {
    if (message.id === liveId) previous = message;
    else if (!message.id.startsWith("progress:") || message.runId) remaining.push(message);
  }
  return { previous, remaining };
}

export function updateCloudAgentMessages<Message extends { id: string; blocks: MessageBlock[] }>(
  messages: readonly Message[],
  payload: Record<string, unknown>,
): Message[] {
  const agentId = String(payload.agentId ?? "");
  const messageId = String(payload.messageId ?? "");
  const block = cloudAgentBlockFromPayload(payload);
  return messages.map((message) => {
    if (
      (messageId && message.id === messageId) ||
      message.blocks.some(
        (existing) => existing.kind === "cloud_agent" && existing.agentId === agentId,
      )
    ) {
      return {
        ...message,
        blocks: message.blocks.map((existing) =>
          existing.kind === "cloud_agent" && existing.agentId === agentId ? block : existing,
        ),
      };
    }
    return message;
  });
}
