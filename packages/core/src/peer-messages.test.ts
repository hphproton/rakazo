import type { ThreadMessage } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  hubExchangeForAnchor,
  peerConversations,
  peerMessagesFrom,
  peerTranscriptForChip,
  peerTurnSpeaker,
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

  it("groups Hub members from one burst into one topic", () => {
    const quill = hubRow("quill", 5, "2026-10-02T12:00:00.000Z", [
      { kind: "hub_message_sent", hubAgentId: "hub-quill", name: "Quill", text: "quill only" },
    ]);
    const fromAtlas = hubExchangeForAnchor([...thread, quill], {
      messageId: "out-smoke",
      peerBotId: HUB,
    });
    const fromQuill = hubExchangeForAnchor([...thread, quill], {
      messageId: "quill",
      peerBotId: "hub-quill",
    });
    const shared = ["quill only", "smoke inbound", "NATIVE_HUB_SEND_SMOKE"];
    expect(fromAtlas?.messages.map((turn) => turn.text)).toEqual(shared);
    expect(fromQuill?.messages.map((turn) => turn.text)).toEqual(shared);
    expect(fromQuill?.peerBotName).toBe("Hub · Quill, Atlas");
    expect(fromQuill?.participants?.map((participant) => participant.peerBotId)).toEqual([
      "hub-quill",
      HUB,
    ]);
    const older = hubExchangeForAnchor([...thread, quill], {
      messageId: "in-old",
      peerBotId: HUB,
    });
    expect(older?.messages.map((turn) => turn.text)).toEqual(["older inbound", "older outbound"]);
    expect(older?.participants).toBeUndefined();
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

  it("opens one topic for a fan-out and both Hub replies", () => {
    const principal = "box-principal";
    const lab = "oss-local-lab";
    const prior = hubOutbound("prior", 1, "2026-10-02T09:00:00.000Z", "earlier 1:1");
    const ask = person("ask", 2, "2026-10-02T10:00:00.000Z", "Ask Principal and Lab");
    const toPrincipal = hubRow("to-principal", 3, "2026-10-02T10:01:00.000Z", [
      {
        kind: "hub_message_sent",
        hubAgentId: principal,
        name: "Box Principal",
        text: "Check the deploy.",
        intent: "request",
      },
    ]);
    const toLab = hubRow("to-lab", 4, "2026-10-02T10:01:01.000Z", [
      {
        kind: "hub_message_sent",
        hubAgentId: lab,
        name: "OSS Local Lab",
        text: "Check the lab.",
        intent: "request",
      },
    ]);
    const asked = hubRow("asked", 5, "2026-10-02T10:01:02.000Z", [
      { kind: "text", text: "Asked both." },
    ]);
    const fromPrincipal = hubRow(
      "from-principal",
      6,
      "2026-10-02T10:02:00.000Z",
      [
        {
          kind: "bot_message_received",
          fromBotId: principal,
          fromBotName: "Box Principal",
          origin: "hub",
          text: "Principal ready.",
        },
      ],
      { role: "user" },
    );
    const fromLab = hubRow(
      "from-lab",
      7,
      "2026-10-02T10:03:00.000Z",
      [
        {
          kind: "bot_message_received",
          fromBotId: lab,
          fromBotName: "OSS Local Lab",
          origin: "hub",
          text: "Lab ready.",
        },
      ],
      { role: "user" },
    );
    const thread = [fromLab, ask, toLab, prior, fromPrincipal, asked, toPrincipal];
    const texts = ["Check the deploy.", "Check the lab.", "Principal ready.", "Lab ready."];
    const fromSend = hubExchangeForAnchor(thread, {
      messageId: "to-principal",
      peerBotId: principal,
    });
    const fromReply = hubExchangeForAnchor(thread, {
      messageId: "from-lab",
      peerBotId: lab,
    });
    expect(fromSend?.messages.map((turn) => turn.text)).toEqual(texts);
    expect(
      fromReply?.messages.map((turn) => [turn.direction, turn.peerBotName, turn.text]),
    ).toEqual([
      ["sent", "Hub · Box Principal", "Check the deploy."],
      ["sent", "Hub · OSS Local Lab", "Check the lab."],
      ["received", "Hub · Box Principal", "Principal ready."],
      ["received", "Hub · OSS Local Lab", "Lab ready."],
    ]);
    expect(fromReply?.messages.map((turn) => turn.text)).toEqual(
      fromSend?.messages.map((t) => t.text),
    );
    expect(fromReply?.peerBotName).toBe("Hub · Box Principal, OSS Local Lab");
    expect(fromReply?.participants?.map((participant) => participant.peerBotId)).toEqual([
      principal,
      lab,
    ]);
    expect(fromReply?.messages.map((turn) => turn.text)).not.toContain("Asked both.");
    expect(
      hubExchangeForAnchor(thread, { messageId: "prior", peerBotId: HUB })?.messages.map(
        (turn) => turn.text,
      ),
    ).toEqual(["earlier 1:1"]);
    expect(peerTurnSpeaker(fromReply!.messages[0]!, "Chief", 2)).toBe(
      "Chief · Hub · Box Principal",
    );
    expect(peerTurnSpeaker(fromReply!.messages[2]!, "Chief", 2)).toBe("Hub · Box Principal");
    expect(peerTurnSpeaker(fromReply!.messages[0]!, "Chief", 1)).toBe("Chief");
  });

  it("groups a burst of Hub replies that arrive before the bot writes back", () => {
    const principal = "box-principal";
    const lab = "oss-local-lab";
    const fromPrincipal = hubRow(
      "from-principal",
      2,
      "2026-10-02T10:02:00.000Z",
      [
        {
          kind: "bot_message_received",
          fromBotId: principal,
          fromBotName: "Box Principal",
          origin: "hub",
          text: "Principal ready.",
        },
      ],
      { role: "user" },
    );
    const fromLab = hubRow(
      "from-lab",
      3,
      "2026-10-02T10:03:00.000Z",
      [
        {
          kind: "bot_message_received",
          fromBotId: lab,
          fromBotName: "OSS Local Lab",
          origin: "hub",
          text: "Lab ready.",
        },
      ],
      { role: "user" },
    );
    const opened = hubExchangeForAnchor([fromLab, fromPrincipal], {
      messageId: "from-principal",
      peerBotId: principal,
    });
    expect(opened?.messages.map((turn) => turn.text)).toEqual(["Principal ready.", "Lab ready."]);
    expect(opened?.participants).toHaveLength(2);
  });

  it("starts a fresh topic once a shared round is complete and the bot replies", () => {
    const principal = "box-principal";
    const lab = "oss-local-lab";
    const toPrincipal = hubRow("to-principal", 2, "2026-10-02T10:01:00.000Z", [
      {
        kind: "hub_message_sent",
        hubAgentId: principal,
        name: "Box Principal",
        text: "Check the deploy.",
      },
    ]);
    const toLab = hubRow("to-lab", 3, "2026-10-02T10:01:01.000Z", [
      { kind: "hub_message_sent", hubAgentId: lab, name: "OSS Local Lab", text: "Check the lab." },
    ]);
    const asked = hubRow("asked", 4, "2026-10-02T10:01:02.000Z", [
      { kind: "text", text: "Asked both." },
    ]);
    const fromPrincipal = hubRow(
      "from-principal",
      5,
      "2026-10-02T10:02:00.000Z",
      [
        {
          kind: "bot_message_received",
          fromBotId: principal,
          fromBotName: "Box Principal",
          origin: "hub",
          text: "Principal ready.",
        },
      ],
      { role: "user" },
    );
    const fromLab = hubRow(
      "from-lab",
      6,
      "2026-10-02T10:03:00.000Z",
      [
        {
          kind: "bot_message_received",
          fromBotId: lab,
          fromBotName: "OSS Local Lab",
          origin: "hub",
          text: "Lab ready.",
        },
      ],
      { role: "user" },
    );
    const done = hubRow("done", 7, "2026-10-02T10:04:00.000Z", [
      { kind: "text", text: "Both answered." },
    ]);
    const later = hubRow("later", 8, "2026-10-02T10:05:00.000Z", [
      {
        kind: "hub_message_sent",
        hubAgentId: principal,
        name: "Box Principal",
        text: "Follow up.",
      },
    ]);
    const messages = [later, done, fromLab, toPrincipal, fromPrincipal, asked, toLab];
    expect(
      hubExchangeForAnchor(messages, { messageId: "from-lab", peerBotId: lab })?.messages.map(
        (turn) => turn.text,
      ),
    ).toEqual(["Check the deploy.", "Check the lab.", "Principal ready.", "Lab ready."]);
    expect(
      hubExchangeForAnchor(messages, { messageId: "later", peerBotId: principal })?.messages.map(
        (turn) => turn.text,
      ),
    ).toEqual(["Follow up."]);
  });

  it("keeps a Hub member who starts after the bot has replied on their own topic", () => {
    const atlas = hubOutbound("atlas", 2, "2026-10-02T10:00:00.000Z", "ask atlas");
    const reply = hubRow("reply", 3, "2026-10-02T10:01:00.000Z", [
      { kind: "text", text: "Asked Atlas." },
    ]);
    const quill = hubRow("quill", 4, "2026-10-02T10:02:00.000Z", [
      { kind: "hub_message_sent", hubAgentId: "hub-quill", name: "Quill", text: "ask quill" },
    ]);
    const atlasReply = hubInbound("atlas-in", 5, "2026-10-02T10:03:00.000Z", "atlas answer");
    const opened = [quill, reply, atlasReply, atlas];
    expect(
      hubExchangeForAnchor(opened, { messageId: "atlas", peerBotId: HUB })?.messages.map(
        (turn) => turn.text,
      ),
    ).toEqual(["ask atlas", "atlas answer"]);
    expect(
      hubExchangeForAnchor(opened, { messageId: "quill", peerBotId: "hub-quill" })?.messages.map(
        (turn) => turn.text,
      ),
    ).toEqual(["ask quill"]);
  });

  it("keeps a teammate chip on one conversation per bot", () => {
    const opened = peerTranscriptForChip(
      [sentToAnalyst, person("gap", 2, "2026-08-25T10:00:30.000Z"), replyFromAnalyst],
      { scope: "peer", messageId: "m_1", peerBotId: "b_2" },
    );
    expect(opened?.messages.map((turn) => turn.text)).toEqual(["chart q3", "done"]);
  });
});
