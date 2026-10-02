import type { ThreadMessage } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  hubChipBlockKey,
  hubExchangeForAnchor,
  hubTopicChipPlan,
  peerConversations,
  peerMessagesFrom,
  peerTranscriptForChip,
} from "./peer-messages.js";

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
    const atlas = peerConversations([inbound, outbound]).find(
      (conversation) => conversation.peerBotId === "hub-atlas",
    );
    expect(atlas?.peerBotName).toBe("Hub · Atlas");
    expect(atlas?.messages.map((turn) => turn.direction)).toEqual(["sent", "received"]);
  });

  it("opens the clicked Hub chip's exchange instead of the latest bag for that member", () => {
    const older = message("m_old", "2026-10-01T10:00:00.000Z", [
      {
        kind: "hub_message_sent",
        hubAgentId: "hub-atlas",
        name: "Atlas",
        text: "older outbound",
        intent: "request",
      },
    ]);
    const boundary = message("m_person", "2026-10-02T09:00:00.000Z", [
      { kind: "text", text: "a different request" },
    ]);
    boundary.role = "user";
    boundary.seq = 4;
    older.seq = 3;
    const smoke = message("m_out", "2026-10-02T15:04:00.000Z", [
      {
        kind: "hub_message_sent",
        hubAgentId: "hub-atlas",
        name: "Atlas",
        text: "NATIVE_HUB_SEND_SMOKE",
        intent: "request",
      },
    ]);
    smoke.seq = 7;
    const opened = peerTranscriptForChip([smoke, boundary, older], {
      scope: "hub",
      messageId: "m_old",
      peerBotId: "hub-atlas",
    });
    expect(opened?.messages.map((turn) => turn.text)).toEqual(["older outbound"]);
    expect(
      peerTranscriptForChip([smoke, boundary, older], {
        scope: "hub",
        messageId: "missing",
        peerBotId: "hub-atlas",
      }),
    ).toBeNull();
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

  it("collapses a multi-party Hub burst to two direction chips that open one topic", () => {
    const principal = "box-principal";
    const lab = "oss-local-lab";
    const thread = [
      message("to-principal", "2026-10-02T10:01:00.000Z", [
        {
          kind: "hub_message_sent",
          hubAgentId: principal,
          name: "Box Principal",
          text: "Check the deploy.",
        },
      ]),
      message("to-lab", "2026-10-02T10:01:01.000Z", [
        {
          kind: "hub_message_sent",
          hubAgentId: lab,
          name: "OSS Local Lab",
          text: "Check the lab.",
        },
      ]),
      message("from-principal", "2026-10-02T10:02:00.000Z", [
        {
          kind: "bot_message_received",
          fromBotId: principal,
          fromBotName: "Box Principal",
          origin: "hub",
          text: "Principal ready.",
        },
      ]),
      message("from-lab", "2026-10-02T10:03:00.000Z", [
        {
          kind: "bot_message_received",
          fromBotId: lab,
          fromBotName: "OSS Local Lab",
          origin: "hub",
          text: "Lab ready.",
        },
      ]),
    ];
    for (const [index, row] of thread.entries()) row.seq = index + 1;
    const plan = hubTopicChipPlan(thread);
    const outbound = plan.families.get(hubChipBlockKey("to-principal", principal, "sent"));
    const inbound = plan.families.get(hubChipBlockKey("from-principal", principal, "received"));
    expect(plan.families.size).toBe(2);
    expect(plan.hiddenMessageIds).toEqual(new Set(["to-lab", "from-lab"]));
    expect(outbound?.names).toEqual(["Box Principal", "OSS Local Lab"]);
    expect(inbound?.names).toEqual(["Box Principal", "OSS Local Lab"]);
    const openedFromSend = hubExchangeForAnchor(thread, {
      messageId: outbound!.messageId,
      peerBotId: outbound!.peerBotId,
    });
    const openedFromReply = hubExchangeForAnchor(thread, {
      messageId: inbound!.messageId,
      peerBotId: inbound!.peerBotId,
    });
    expect(openedFromReply?.messages.map((turn) => turn.text)).toEqual(
      openedFromSend?.messages.map((turn) => turn.text),
    );
    expect(openedFromSend?.messages).toHaveLength(4);
  });
});
