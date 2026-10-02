import type { ThreadMessage } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  hubExchangeForAnchor,
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

const HUB = "hub-atlas";

function hubRow(
  id: string,
  seq: number,
  createdAt: string,
  blocks: ThreadMessage["blocks"],
  extras?: Partial<Pick<ThreadMessage, "role" | "threadId">>,
): ThreadMessage {
  return {
    id,
    threadId: extras?.threadId ?? "thread-chief",
    seq,
    role: extras?.role ?? "bot",
    blocks,
    createdAt,
  };
}

function person(id: string, seq: number, createdAt: string, text = "next"): ThreadMessage {
  return hubRow(id, seq, createdAt, [{ kind: "text", text }], { role: "user" });
}

function hubInbound(id: string, seq: number, createdAt: string, text: string): ThreadMessage {
  return hubRow(
    id,
    seq,
    createdAt,
    [
      {
        kind: "bot_message_received",
        fromBotId: HUB,
        fromBotName: "Atlas",
        origin: "hub",
        text,
      },
    ],
    { role: "user" },
  );
}

function hubOutbound(id: string, seq: number, createdAt: string, text: string): ThreadMessage {
  return hubRow(id, seq, createdAt, [
    { kind: "hub_message_sent", hubAgentId: HUB, name: "Atlas", text, intent: "request" },
  ]);
}

describe("hub chip transcripts", () => {
  const olderInbound = hubInbound("in-old", 2, "2026-10-01T10:00:00.000Z", "older inbound");
  const olderOutbound = hubOutbound("out-old", 3, "2026-10-01T10:01:00.000Z", "older outbound");
  const boundary = person("person", 4, "2026-10-02T09:00:00.000Z", "a different request");
  const smokeInbound = hubInbound("in-smoke", 6, "2026-10-02T15:00:00.000Z", "smoke inbound");
  const smokeOutbound = hubOutbound(
    "out-smoke",
    7,
    "2026-10-02T15:05:00.000Z",
    "NATIVE_HUB_SEND_SMOKE",
  );
  const thread = [smokeOutbound, olderInbound, boundary, smokeInbound, olderOutbound];

  it("keeps both directions of one exchange on either chip", () => {
    const exchange = [olderInbound, olderOutbound];
    const fromInbound = hubExchangeForAnchor(exchange, { messageId: "in-old", peerBotId: HUB });
    const fromOutbound = hubExchangeForAnchor(exchange, { messageId: "out-old", peerBotId: HUB });
    expect(fromInbound?.messages.map((turn) => [turn.direction, turn.text])).toEqual([
      ["received", "older inbound"],
      ["sent", "older outbound"],
    ]);
    expect(fromOutbound?.messages.map((turn) => turn.text)).toEqual(
      fromInbound?.messages.map((turn) => turn.text),
    );
  });

  it("opens an older chip on its own messages, not the latest smoke exchange", () => {
    const bag = peerConversations(thread).find((conversation) => conversation.peerBotId === HUB);
    expect(bag?.messages.map((turn) => turn.text)).toEqual([
      "older inbound",
      "older outbound",
      "smoke inbound",
      "NATIVE_HUB_SEND_SMOKE",
    ]);

    const older = peerTranscriptForChip(thread, {
      scope: "hub",
      messageId: "in-old",
      peerBotId: HUB,
    });
    const smoke = peerTranscriptForChip(thread, {
      scope: "hub",
      messageId: "out-smoke",
      peerBotId: HUB,
    });
    expect(older?.messages.map((turn) => turn.text)).toEqual(["older inbound", "older outbound"]);
    expect(smoke?.messages.map((turn) => turn.text)).toEqual([
      "smoke inbound",
      "NATIVE_HUB_SEND_SMOKE",
    ]);
    expect(older?.messages.map((turn) => turn.text)).not.toContain("NATIVE_HUB_SEND_SMOKE");
  });

  it("does not fall back to the latest exchange when the chip message is missing", () => {
    expect(hubExchangeForAnchor(thread, { messageId: "missing-chip", peerBotId: HUB })).toBeNull();
    expect(
      peerTranscriptForChip(thread, { scope: "hub", messageId: "missing-chip", peerBotId: HUB }),
    ).toBeNull();
  });

  it("does not open a different member when the chip id and the message disagree", () => {
    expect(
      hubExchangeForAnchor(thread, { messageId: "out-old", peerBotId: "someone-else" }),
    ).toBeNull();
  });

  it("keeps distinct Hub members as distinct topics in one stretch", () => {
    const quill = hubRow("quill", 5, "2026-10-02T12:00:00.000Z", [
      { kind: "hub_message_sent", hubAgentId: "hub-quill", name: "Quill", text: "quill only" },
    ]);
    const atlas = hubExchangeForAnchor([...thread, quill], {
      messageId: "out-smoke",
      peerBotId: HUB,
    });
    const other = hubExchangeForAnchor([...thread, quill], {
      messageId: "quill",
      peerBotId: "hub-quill",
    });
    expect(atlas?.messages.map((turn) => turn.text)).toEqual([
      "smoke inbound",
      "NATIVE_HUB_SEND_SMOKE",
    ]);
    expect(other?.messages.map((turn) => turn.text)).toEqual(["quill only"]);
  });

  it("keeps the answering outbound with its inbound across the bot reply", () => {
    const reply = hubRow("reply", 3, "2026-10-01T10:02:00.000Z", [
      { kind: "text", text: "Queued for Atlas." },
    ]);
    const outbound = hubOutbound("out", 4, "2026-10-01T10:03:00.000Z", "NATIVE_HUB_SEND_SMOKE");
    const inbound = hubInbound("in", 2, "2026-10-01T10:01:00.000Z", "Check the deploy.");
    const fromChip = (messageId: string) =>
      hubExchangeForAnchor([outbound, reply, inbound], { messageId, peerBotId: HUB });
    expect(fromChip("in")?.messages.map((turn) => [turn.direction, turn.text])).toEqual([
      ["received", "Check the deploy."],
      ["sent", "NATIVE_HUB_SEND_SMOKE"],
    ]);
    expect(fromChip("out")?.messages.map((turn) => turn.text)).toEqual(
      fromChip("in")?.messages.map((turn) => turn.text),
    );
  });

  it("keeps a later inbound with the outbound it answers", () => {
    const outbound = hubOutbound("out", 2, "2026-10-01T10:00:00.000Z", "question");
    const reply = hubRow("reply", 3, "2026-10-01T10:01:00.000Z", [
      { kind: "text", text: "Asked." },
    ]);
    const inbound = hubInbound("in", 4, "2026-10-01T10:02:00.000Z", "answer");
    expect(
      hubExchangeForAnchor([reply, inbound, outbound], {
        messageId: "out",
        peerBotId: HUB,
      })?.messages.map((turn) => turn.text),
    ).toEqual(["question", "answer"]);
  });

  it("starts a new exchange after the bot replies once both directions are present", () => {
    const reply = hubRow("reply", 4, "2026-10-01T10:02:00.000Z", [
      { kind: "text", text: "Done with the first request." },
    ]);
    const later = hubOutbound("later", 5, "2026-10-01T10:03:00.000Z", "NATIVE_HUB_SEND_SMOKE");
    const opened = hubExchangeForAnchor([olderOutbound, olderInbound, reply, later], {
      messageId: "in-old",
      peerBotId: HUB,
    });
    const smoke = hubExchangeForAnchor([olderOutbound, olderInbound, reply, later], {
      messageId: "later",
      peerBotId: HUB,
    });
    expect(opened?.messages.map((turn) => turn.text)).toEqual(["older inbound", "older outbound"]);
    expect(smoke?.messages.map((turn) => turn.text)).toEqual(["NATIVE_HUB_SEND_SMOKE"]);
  });

  it("keeps two Rakazo bots messaging one Hub member on separate transcripts", () => {
    const chief = hubOutbound("chief-send", 1, "2026-10-02T10:00:00.000Z", "from chief");
    const scout = hubRow(
      "scout-send",
      1,
      "2026-10-02T11:00:00.000Z",
      [{ kind: "hub_message_sent", hubAgentId: HUB, name: "Atlas", text: "from scout" }],
      { threadId: "thread-scout" },
    );
    const chiefInbound = hubRow(
      "chief-in",
      2,
      "2026-10-02T10:05:00.000Z",
      [
        {
          kind: "bot_message_received",
          fromBotId: HUB,
          fromBotName: "Atlas",
          origin: "hub",
          text: "reply to chief",
        },
      ],
      { role: "user", threadId: "thread-chief" },
    );
    const mixed = [scout, chief, chiefInbound];
    expect(
      hubExchangeForAnchor(mixed, { messageId: "chief-send", peerBotId: HUB })?.messages.map(
        (turn) => turn.text,
      ),
    ).toEqual(["from chief", "reply to chief"]);
    expect(
      hubExchangeForAnchor(mixed, { messageId: "scout-send", peerBotId: HUB })?.messages.map(
        (turn) => turn.text,
      ),
    ).toEqual(["from scout"]);
  });

  it("keeps a teammate chip on one conversation per bot", () => {
    const opened = peerTranscriptForChip(
      [sentToAnalyst, person("gap", 2, "2026-08-25T10:00:30.000Z"), replyFromAnalyst],
      { scope: "peer", messageId: "m_1", peerBotId: "b_2" },
    );
    expect(opened?.messages.map((turn) => turn.text)).toEqual(["chart q3", "done"]);
  });
});
