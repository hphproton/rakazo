import type { ThreadMessage } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { peerConversations, peerMessagesFrom } from "./peer-messages.js";

function message(id: string, createdAt: string, blocks: ThreadMessage["blocks"]): ThreadMessage {
  return { id, threadId: "t_1", seq: 1, role: "bot", blocks, createdAt };
}

const sentToAnalyst = message("m_1", "2026-08-25T10:00:00.000Z", [
  { kind: "bot_message_sent", toBotId: "b_2", toBotName: "Analyst", text: "chart q3" },
]);
const replyFromAnalyst = message("m_2", "2026-08-25T10:01:00.000Z", [
  { kind: "bot_message_received", fromBotId: "b_2", fromBotName: "Analyst", text: "done" },
]);
const plainText = message("m_3", "2026-08-25T10:02:00.000Z", [{ kind: "text", text: "hello" }]);

describe("peer conversations", () => {
  const messages = [sentToAnalyst, replyFromAnalyst, plainText];

  it("prefixes a Hub receipt so the peer view is not a teammate name alone", () => {
    const hub = message("m_hub", "2026-08-25T10:03:00.000Z", [
      {
        kind: "bot_message_received",
        fromBotId: "hub-atlas",
        fromBotName: "Atlas",
        origin: "hub",
        text: "Check the deploy.",
      },
    ]);
    expect(peerMessagesFrom([hub])).toEqual([
      expect.objectContaining({
        direction: "received",
        peerBotId: "hub-atlas",
        peerBotName: "Hub · Atlas",
        text: "Check the deploy.",
      }),
    ]);
  });

  it("puts a Hub outbound echo in the same conversation as that member's inbound", () => {
    const outbound = message("m_out", "2026-08-25T10:04:00.000Z", [
      {
        kind: "hub_message_sent",
        hubAgentId: "hub-atlas",
        name: "Atlas",
        text: "NATIVE_HUB_SEND_SMOKE",
        intent: "request",
      },
    ]);
    const inbound = message("m_in", "2026-08-25T10:05:00.000Z", [
      {
        kind: "bot_message_received",
        fromBotId: "hub-atlas",
        fromBotName: "Atlas",
        origin: "hub",
        text: "Check the deploy.",
      },
    ]);
    const other = message("m_other", "2026-08-25T10:06:00.000Z", [
      {
        kind: "hub_message_sent",
        hubAgentId: "box-principal",
        name: "Box Principal",
        text: "other thread",
      },
    ]);
    const conversations = peerConversations([inbound, outbound, other]);
    const atlas = conversations.find((conversation) => conversation.peerBotId === "hub-atlas");
    expect(atlas?.peerBotName).toBe("Hub · Atlas");
    expect(atlas?.messages.map((turn) => [turn.direction, turn.text])).toEqual([
      ["sent", "NATIVE_HUB_SEND_SMOKE"],
      ["received", "Check the deploy."],
    ]);
    expect(
      conversations.find((conversation) => conversation.peerBotId === "box-principal"),
    ).toMatchObject({
      peerBotName: "Hub · Box Principal",
      lastText: "other thread",
    });
  });

  it("reads both directions out of the thread", () => {
    expect(peerMessagesFrom(messages)).toEqual([
      expect.objectContaining({ direction: "sent", peerBotName: "Analyst", text: "chart q3" }),
      expect.objectContaining({ direction: "received", peerBotName: "Analyst", text: "done" }),
    ]);
  });

  it("groups an exchange with one peer into a single conversation", () => {
    const conversations = peerConversations(messages);
    expect(conversations).toHaveLength(1);
    expect(conversations[0]?.peerBotName).toBe("Analyst");
    expect(conversations[0]?.messages).toHaveLength(2);
    expect(conversations[0]?.lastText).toBe("done");
  });

  it("orders conversations by most recent activity", () => {
    const older = message("m_0", "2026-08-24T09:00:00.000Z", [
      { kind: "bot_message_sent", toBotId: "b_3", toBotName: "Scout", text: "look into it" },
    ]);
    expect(peerConversations([older, ...messages]).map((c) => c.peerBotName)).toEqual([
      "Analyst",
      "Scout",
    ]);
  });

  it("finds nothing in a thread with no peer traffic", () => {
    expect(peerConversations([plainText])).toEqual([]);
  });
});
