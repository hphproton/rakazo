import type { ThreadMessage } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  hubChipBlockKey,
  hubExchangeForAnchor,
  hubReceiptRowHidden,
  hubTopicChipPlan,
  hubTranscriptTitle,
  messagesForHubTranscript,
  peerConversations,
  peerMessagesFrom,
  peerTranscriptForChip,
  peerTurnSpeaker,
  spaceTopicKeyForHubSend,
  spaceTopicKeyOnAnchor,
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
      ["sent", "Queued for Atlas."],
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
    expect(opened?.messages.map((turn) => turn.text)).toEqual([
      "older inbound",
      "older outbound",
      "Done with the first request.",
    ]);
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
    ).toEqual([
      "Check the deploy.",
      "Check the lab.",
      "Principal ready.",
      "Lab ready.",
      "Both answered.",
    ]);
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

describe("hub topic chip collapse", () => {
  const principal = "box-principal";
  const lab = "oss-local-lab";

  function multiPartyThread() {
    const prior = hubOutbound("prior", 1, "2026-10-02T09:00:00.000Z", "earlier 1:1");
    const priorReply = hubInbound("prior-reply", 2, "2026-10-02T09:01:00.000Z", "earlier reply");
    const ask = person("ask", 3, "2026-10-02T10:00:00.000Z", "Ask Principal and Lab");
    const toPrincipal = hubRow("to-principal", 4, "2026-10-02T10:01:00.000Z", [
      {
        kind: "hub_message_sent",
        hubAgentId: principal,
        name: "Box Principal",
        text: "Check the deploy.",
      },
    ]);
    const toLab = hubRow("to-lab", 5, "2026-10-02T10:01:01.000Z", [
      { kind: "hub_message_sent", hubAgentId: lab, name: "OSS Local Lab", text: "Check the lab." },
    ]);
    const asked = hubRow("asked", 6, "2026-10-02T10:01:02.000Z", [
      { kind: "text", text: "Asked both." },
    ]);
    const fromPrincipal = hubRow(
      "from-principal",
      7,
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
      8,
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
    return [prior, priorReply, ask, toPrincipal, toLab, asked, fromPrincipal, fromLab];
  }

  it("collapses a multi-party burst to one outbound chip and one inbound chip", () => {
    const thread = multiPartyThread();
    const plan = hubTopicChipPlan(thread);
    const outbound = plan.families.get(hubChipBlockKey("to-principal", principal, "sent"));
    const inbound = plan.families.get(hubChipBlockKey("from-principal", principal, "received"));

    expect(plan.families.size).toBe(2);
    expect(outbound).toMatchObject({
      direction: "sent",
      messageId: "to-principal",
      peerBotId: principal,
      peerBotName: "Hub · Box Principal",
      names: ["Box Principal", "OSS Local Lab"],
    });
    expect(inbound).toMatchObject({
      direction: "received",
      messageId: "from-principal",
      peerBotId: principal,
      peerBotName: "Hub · Box Principal",
      names: ["Box Principal", "OSS Local Lab"],
    });
    expect(plan.omittedBlockKeys.has(hubChipBlockKey("to-lab", lab, "sent"))).toBe(true);
    expect(plan.omittedBlockKeys.has(hubChipBlockKey("from-lab", lab, "received"))).toBe(true);
    expect(plan.hiddenMessageIds).toEqual(new Set(["to-lab", "from-lab"]));
    expect(hubReceiptRowHidden(plan, thread.find((message) => message.id === "to-lab")!)).toBe(
      true,
    );
    expect(hubReceiptRowHidden(plan, thread.find((message) => message.id === "asked")!)).toBe(
      false,
    );

    const fromSend = hubExchangeForAnchor(thread, {
      messageId: outbound!.messageId,
      peerBotId: outbound!.peerBotId,
    });
    const fromReply = hubExchangeForAnchor(thread, {
      messageId: inbound!.messageId,
      peerBotId: inbound!.peerBotId,
    });
    expect(fromSend?.messages.map((turn) => turn.text)).toEqual([
      "Check the deploy.",
      "Check the lab.",
      "Principal ready.",
      "Lab ready.",
    ]);
    expect(fromReply?.messages.map((turn) => turn.text)).toEqual(
      fromSend?.messages.map((turn) => turn.text),
    );
  });

  it("leaves a closed 1:1 on its own chips", () => {
    const thread = multiPartyThread();
    const plan = hubTopicChipPlan(thread);
    expect(plan.families.has(hubChipBlockKey("prior", HUB, "sent"))).toBe(false);
    expect(plan.families.has(hubChipBlockKey("prior-reply", HUB, "received"))).toBe(false);
    expect(plan.hiddenMessageIds.has("prior")).toBe(false);
    expect(plan.hiddenMessageIds.has("prior-reply")).toBe(false);
    expect(
      hubExchangeForAnchor(thread, { messageId: "prior", peerBotId: HUB })?.messages.map(
        (turn) => turn.text,
      ),
    ).toEqual(["earlier 1:1", "earlier reply"]);
  });

  it("does not collapse a single-member send and reply", () => {
    const outbound = hubOutbound("out", 1, "2026-10-02T10:00:00.000Z", "ask atlas");
    const inbound = hubInbound("in", 2, "2026-10-02T10:01:00.000Z", "atlas answer");
    const plan = hubTopicChipPlan([outbound, inbound]);
    expect(plan.families.size).toBe(0);
    expect(plan.omittedBlockKeys.size).toBe(0);
    expect(plan.hiddenMessageIds.size).toBe(0);
  });

  it("collapses a burst of replies that share a topic and have no sends", () => {
    const fromPrincipal = hubRow(
      "from-principal",
      1,
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
      2,
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
    const plan = hubTopicChipPlan([fromPrincipal, fromLab]);
    expect([...plan.families.values()]).toEqual([
      expect.objectContaining({
        direction: "received",
        messageId: "from-principal",
        names: ["Box Principal", "OSS Local Lab"],
      }),
    ]);
    expect(plan.hiddenMessageIds).toEqual(new Set(["from-lab"]));
  });

  it("collapses each Rakazo bot thread on its own", () => {
    const send = (id: string, threadId: string, hubAgentId: string, name: string, text: string) =>
      hubRow(
        id,
        1,
        "2026-10-02T10:01:00.000Z",
        [{ kind: "hub_message_sent", hubAgentId, name, text }],
        { threadId },
      );
    const plan = hubTopicChipPlan([
      send("chief-principal", "thread-chief", principal, "Box Principal", "from chief"),
      send("chief-lab", "thread-chief", lab, "OSS Local Lab", "lab from chief"),
      send("scout-principal", "thread-scout", principal, "Box Principal", "from scout"),
      send("scout-lab", "thread-scout", lab, "OSS Local Lab", "lab from scout"),
    ]);
    expect(plan.families.size).toBe(2);
    expect(plan.families.get(hubChipBlockKey("chief-principal", principal, "sent"))?.names).toEqual(
      ["Box Principal", "OSS Local Lab"],
    );
    expect(plan.families.get(hubChipBlockKey("scout-principal", principal, "sent"))?.names).toEqual(
      ["Box Principal", "OSS Local Lab"],
    );
    expect(plan.hiddenMessageIds).toEqual(new Set(["chief-lab", "scout-lab"]));
  });

  it("keeps a one-member direction as a leg chip inside a multi-member topic", () => {
    const toPrincipal = hubRow("to-principal", 1, "2026-10-02T10:01:00.000Z", [
      {
        kind: "hub_message_sent",
        hubAgentId: principal,
        name: "Box Principal",
        text: "Check the deploy.",
      },
    ]);
    const toLab = hubRow("to-lab", 2, "2026-10-02T10:01:01.000Z", [
      { kind: "hub_message_sent", hubAgentId: lab, name: "OSS Local Lab", text: "Check the lab." },
    ]);
    const fromPrincipal = hubRow(
      "from-principal",
      3,
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
    const plan = hubTopicChipPlan([toPrincipal, toLab, fromPrincipal]);
    expect(plan.families.size).toBe(1);
    expect(plan.families.has(hubChipBlockKey("from-principal", principal, "received"))).toBe(false);
    expect(plan.hiddenMessageIds.has("from-principal")).toBe(false);
  });
});

describe("space-wide hub topic", () => {
  const principal = "box-principal";
  const lab = "oss-local-lab";
  const key = "burst-1";
  const chief = { id: "bot-chief", name: "Chief" };
  const deputy = { id: "bot-deputy", name: "Deputy" };

  type Row = ThreadMessage & { botName?: string };

  function burst(
    threadId: string,
    prefix: string,
    bot: { id: string; name: string },
    spaceTopicKey?: string,
  ): Row[] {
    const row = (
      id: string,
      seq: number,
      createdAt: string,
      blocks: ThreadMessage["blocks"],
      role: ThreadMessage["role"] = "bot",
    ): Row => ({
      id: `${prefix}-${id}`,
      threadId,
      seq,
      role,
      blocks: spaceTopicKey
        ? blocks.map((block) => ({ ...block, spaceTopicKey }) as ThreadMessage["blocks"][number])
        : blocks,
      createdAt,
      botId: bot.id,
      botName: bot.name,
    });
    return [
      row("out-p", 1, "2026-10-02T10:00:00.000Z", [
        {
          kind: "hub_message_sent",
          hubAgentId: principal,
          name: "Box Principal",
          text: "Check the deploy.",
        },
      ]),
      row("out-l", 2, "2026-10-02T10:01:00.000Z", [
        {
          kind: "hub_message_sent",
          hubAgentId: lab,
          name: "OSS Local Lab",
          text: "Check the lab.",
        },
      ]),
      row(
        "in-p",
        3,
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
        "user",
      ),
      row(
        "in-l",
        4,
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
        "user",
      ),
    ];
  }

  function ids(opened: { messages: Array<{ messageId: string }> } | null): string[] {
    return opened?.messages.map((turn) => turn.messageId) ?? [];
  }

  it("keeps identical bursts disjoint when no spaceTopicKey is set", () => {
    const chiefThread = burst("thread-chief", "c", chief);
    const deputyThread = burst("thread-deputy", "d", deputy);
    const both = [...chiefThread, ...deputyThread];
    const chiefPlan = hubTopicChipPlan(chiefThread);
    const deputyPlan = hubTopicChipPlan(deputyThread);
    const combined = hubTopicChipPlan(both);

    expect(chiefPlan.families.size).toBeLessThanOrEqual(2);
    expect(deputyPlan.families.size).toBeLessThanOrEqual(2);
    expect(chiefPlan.families.size).toBe(2);
    expect(deputyPlan.families.size).toBe(2);
    expect(combined.families.size).toBe(4);

    const chiefOpened = hubExchangeForAnchor(both, { messageId: "c-out-p", peerBotId: principal });
    const deputyOpened = hubExchangeForAnchor(both, { messageId: "d-out-p", peerBotId: principal });
    const chiefIds = ids(chiefOpened);
    const deputyIds = ids(deputyOpened);
    expect(chiefIds).toEqual(["c-out-p", "c-out-l", "c-in-p", "c-in-l"]);
    expect(deputyIds.filter((id) => chiefIds.includes(id))).toEqual([]);
    expect(chiefOpened?.rakazoBots).toBeUndefined();
  });

  it("joins Chief and Deputy only when both bursts carry the same key", () => {
    const chiefThread = burst("thread-chief", "c", chief, key);
    const deputyThread = burst("thread-deputy", "d", deputy, key);
    const both = [...chiefThread, ...deputyThread];
    expect(hubTopicChipPlan(chiefThread).families.size).toBe(2);
    expect(hubTopicChipPlan(deputyThread).families.size).toBe(2);
    expect(hubTopicChipPlan(both).families.size).toBe(4);

    const fromChief = hubExchangeForAnchor(both, { messageId: "c-out-p", peerBotId: principal });
    const fromDeputy = hubExchangeForAnchor(both, { messageId: "d-in-l", peerBotId: lab });
    const shared = [
      "c-out-p",
      "d-out-p",
      "c-out-l",
      "d-out-l",
      "c-in-p",
      "d-in-p",
      "c-in-l",
      "d-in-l",
    ];
    expect(ids(fromChief)).toEqual(shared);
    expect(ids(fromDeputy)).toEqual(shared);
    expect(fromChief?.rakazoBots).toEqual([
      { botId: chief.id, botName: "Chief" },
      { botId: deputy.id, botName: "Deputy" },
    ]);
    expect(hubTranscriptTitle("Chief", fromChief!)).toBe(
      "Chief, Deputy · Hub · Box Principal, OSS Local Lab",
    );
    expect(peerTurnSpeaker(fromChief!.messages[0]!, "Chief", 2)).toBe(
      "Chief · Hub · Box Principal",
    );
    expect(peerTurnSpeaker(fromChief!.messages[1]!, "Chief", 2)).toBe(
      "Deputy · Hub · Box Principal",
    );
    expect(fromDeputy?.messages[4]?.peerBotName).toBe("Hub · Box Principal");
  });

  it("does not merge separate 1:1 topics unless callers pass the same key", () => {
    const chiefOnly: Row = {
      id: "c-only",
      threadId: "thread-chief",
      seq: 1,
      role: "bot",
      botId: chief.id,
      botName: chief.name,
      createdAt: "2026-10-02T10:00:00.000Z",
      blocks: [
        {
          kind: "hub_message_sent",
          hubAgentId: principal,
          name: "Box Principal",
          text: "Check the deploy.",
        },
      ],
    };
    const deputyOnly: Row = {
      id: "d-only",
      threadId: "thread-deputy",
      seq: 1,
      role: "bot",
      botId: deputy.id,
      botName: deputy.name,
      createdAt: "2026-10-02T10:00:00.000Z",
      blocks: [
        {
          kind: "hub_message_sent",
          hubAgentId: lab,
          name: "OSS Local Lab",
          text: "Check the lab.",
        },
      ],
    };
    const apart = hubExchangeForAnchor([chiefOnly, deputyOnly], {
      messageId: "c-only",
      peerBotId: principal,
    });
    expect(ids(apart)).toEqual(["c-only"]);
    expect(hubTopicChipPlan([chiefOnly, deputyOnly]).families.size).toBe(0);

    const keyedChief: Row = {
      ...chiefOnly,
      blocks: [{ ...chiefOnly.blocks[0]!, spaceTopicKey: key } as ThreadMessage["blocks"][number]],
    };
    const keyedDeputy: Row = {
      ...deputyOnly,
      blocks: [{ ...deputyOnly.blocks[0]!, spaceTopicKey: key } as ThreadMessage["blocks"][number]],
    };
    const joined = hubExchangeForAnchor([keyedChief, keyedDeputy], {
      messageId: "c-only",
      peerBotId: principal,
    });
    expect(ids(joined)).toEqual(["c-only", "d-only"]);
    expect(hubTopicChipPlan([keyedChief, keyedDeputy]).families.size).toBe(0);
    expect(hubTranscriptTitle("Chief", joined!)).toBe(
      "Chief, Deputy · Hub · Box Principal, OSS Local Lab",
    );
  });

  it("does not join a different key, shared text, or an over-long key", () => {
    const chiefThread = burst("thread-chief", "c", chief, key);
    const other = burst("thread-deputy", "d", deputy, "burst-2");
    const opened = hubExchangeForAnchor([...chiefThread, ...other], {
      messageId: "c-out-p",
      peerBotId: principal,
    });
    expect(ids(opened).some((id) => id.startsWith("d-"))).toBe(false);

    const tooLong = "a".repeat(201);
    const noisy = burst("thread-deputy", "d", deputy, tooLong);
    expect(
      spaceTopicKeyOnAnchor(noisy, { messageId: "d-out-p", peerBotId: principal }),
    ).toBeUndefined();
    expect(
      ids(
        hubExchangeForAnchor([...chiefThread, ...noisy], {
          messageId: "c-out-p",
          peerBotId: principal,
        }),
      ).some((id) => id.startsWith("d-")),
    ).toBe(false);
    expect(
      messagesForHubTranscript(chiefThread, other, { messageId: "c-in-p", peerBotId: principal }),
    ).toEqual(chiefThread);
  });

  it("closes a topic on that bot's thread only", () => {
    const chiefThread = burst("thread-chief", "c", chief, key);
    const deputyThread = burst("thread-deputy", "d", deputy, key);
    const person: Row = {
      id: "c-person",
      threadId: "thread-chief",
      seq: 5,
      role: "user",
      botId: chief.id,
      botName: chief.name,
      createdAt: "2026-10-02T11:00:00.000Z",
      blocks: [{ kind: "text", text: "next" }],
    };
    const later: Row = {
      id: "c-later",
      threadId: "thread-chief",
      seq: 6,
      role: "bot",
      botId: chief.id,
      botName: chief.name,
      createdAt: "2026-10-02T11:01:00.000Z",
      blocks: [
        {
          kind: "hub_message_sent",
          hubAgentId: principal,
          name: "Box Principal",
          text: "a new 1:1",
        },
      ],
    };
    const messages = [...chiefThread, ...deputyThread, person, later];
    expect(spaceTopicKeyForHubSend(messages, "thread-chief", principal)).toBeUndefined();
    expect(spaceTopicKeyForHubSend(messages, "thread-deputy", lab)).toBe(key);
    expect(spaceTopicKeyForHubSend(deputyThread, "thread-deputy", principal)).toBe(key);
    const opened = hubExchangeForAnchor(messages, { messageId: "c-out-p", peerBotId: principal });
    expect(ids(opened)).toContain("d-out-l");
    expect(ids(opened)).not.toContain("c-later");
    expect(
      ids(hubExchangeForAnchor(messages, { messageId: "c-later", peerBotId: principal })),
    ).toEqual(["c-later"]);
    expect(hubTopicChipPlan(messages).families.size).toBe(4);
    expect(hubTopicChipPlan(chiefThread).families.size).toBeLessThanOrEqual(2);
  });

  it("copies an open key for the answering send and does not invent one after the topic splits", () => {
    const inbound: Row = {
      id: "in",
      threadId: "thread-chief",
      seq: 1,
      role: "user",
      createdAt: "2026-10-02T10:00:00.000Z",
      blocks: [
        {
          kind: "bot_message_received",
          fromBotId: principal,
          fromBotName: "Box Principal",
          origin: "hub",
          text: "ping",
          spaceTopicKey: key,
        },
      ],
    };
    const reply: Row = {
      id: "reply",
      threadId: "thread-chief",
      seq: 2,
      role: "bot",
      createdAt: "2026-10-02T10:01:00.000Z",
      blocks: [{ kind: "text", text: "working" }],
    };
    expect(spaceTopicKeyForHubSend([inbound], "thread-chief", principal)).toBe(key);
    expect(spaceTopicKeyForHubSend([inbound], "thread-chief", lab)).toBe(key);
    expect(spaceTopicKeyForHubSend([inbound, reply], "thread-chief", principal)).toBe(key);
    expect(spaceTopicKeyForHubSend([inbound, reply], "thread-chief", lab)).toBeUndefined();
  });

  it("shows each bot's reply on the shared topic and keeps one chip per bot", () => {
    const chiefThread = [
      ...burst("thread-chief", "c", chief, key),
      {
        id: "c-reply",
        threadId: "thread-chief",
        seq: 5,
        role: "bot" as const,
        botId: chief.id,
        botName: chief.name,
        createdAt: "2026-10-02T10:04:00.000Z",
        blocks: [{ kind: "text" as const, text: "Chief on it." }],
      },
      {
        id: "c-ack",
        threadId: "thread-chief",
        seq: 6,
        role: "bot" as const,
        botId: chief.id,
        botName: chief.name,
        createdAt: "2026-10-02T10:04:30.000Z",
        blocks: [{ kind: "text" as const, text: "OK." }],
      },
    ];
    const deputyThread = [
      ...burst("thread-deputy", "d", deputy, key),
      {
        id: "d-reply",
        threadId: "thread-deputy",
        seq: 5,
        role: "bot" as const,
        botId: deputy.id,
        botName: deputy.name,
        createdAt: "2026-10-02T10:05:00.000Z",
        blocks: [{ kind: "text" as const, text: "Deputy on it." }],
      },
    ];
    const unrelated: Row = {
      id: "d-other",
      threadId: "thread-deputy",
      seq: 9,
      role: "bot",
      botId: deputy.id,
      botName: deputy.name,
      createdAt: "2026-10-02T12:00:00.000Z",
      blocks: [
        { kind: "hub_message_sent", hubAgentId: lab, name: "OSS Local Lab", text: "later lab" },
      ],
    };
    const both = [...chiefThread, ...deputyThread];
    const opened = hubExchangeForAnchor(both, { messageId: "c-in-p", peerBotId: principal });
    expect(ids(opened)).toEqual([
      "c-out-p",
      "d-out-p",
      "c-out-l",
      "d-out-l",
      "c-in-p",
      "d-in-p",
      "c-in-l",
      "d-in-l",
      "c-reply",
      "d-reply",
    ]);
    expect(opened?.messages.map((turn) => turn.text)).toContain("Chief on it.");
    expect(opened?.messages.map((turn) => turn.text)).toContain("Deputy on it.");
    expect(opened?.messages.map((turn) => turn.text)).not.toContain("OK.");
    expect(peerTurnSpeaker(opened!.messages.at(-2)!, "Chief", 2)).toBe("Chief");
    expect(peerTurnSpeaker(opened!.messages.at(-1)!, "Deputy", 2)).toBe("Deputy");
    expect(hubTranscriptTitle("Chief", opened!)).toBe(
      "Chief, Deputy · Hub · Box Principal, OSS Local Lab",
    );

    const chiefPlan = hubTopicChipPlan(chiefThread);
    const deputyPlan = hubTopicChipPlan(deputyThread);
    const combined = hubTopicChipPlan([...both, unrelated]);
    expect(chiefPlan.families.size).toBe(2);
    expect(deputyPlan.families.size).toBe(2);
    expect(combined.families.size).toBe(4);
    expect(chiefPlan.hiddenMessageIds.has("c-reply")).toBe(false);
    expect([...combined.families.values()].every((family) => family.names.length === 2)).toBe(true);

    const loaded = messagesForHubTranscript(chiefThread, [...deputyThread, unrelated], {
      messageId: "c-in-p",
      peerBotId: principal,
    });
    expect(loaded.map((message) => message.id)).toContain("d-reply");
    expect(loaded.map((message) => message.id)).toContain("c-reply");
    expect(loaded.map((message) => message.id)).not.toContain("d-other");
  });

  it("shows each bot's run reply on the shared topic after the thread moves on", () => {
    const chiefReceipt: Row = {
      id: "c-in",
      threadId: "thread-chief",
      seq: 1,
      role: "user",
      runId: "run-chief",
      botId: chief.id,
      botName: chief.name,
      createdAt: "2026-10-02T10:00:01.000Z",
      blocks: [
        {
          kind: "bot_message_received",
          fromBotId: principal,
          fromBotName: "Box Principal",
          origin: "hub",
          text: "Principal to Chief.",
          spaceTopicKey: key,
        },
      ],
    };
    const deputyReceipt: Row = {
      id: "d-in",
      threadId: "thread-deputy",
      seq: 1,
      role: "user",
      runId: "run-deputy",
      botId: deputy.id,
      botName: deputy.name,
      createdAt: "2026-10-02T10:00:00.000Z",
      blocks: [
        {
          kind: "bot_message_received",
          fromBotId: principal,
          fromBotName: "Box Principal",
          origin: "hub",
          text: "Principal to Deputy.",
          spaceTopicKey: key,
        },
      ],
    };
    const chiefThread: Row[] = [
      {
        id: "c-before",
        threadId: "thread-chief",
        seq: 0,
        role: "bot",
        runId: "run-chief",
        botId: chief.id,
        botName: chief.name,
        createdAt: "2026-10-02T09:59:00.000Z",
        blocks: [{ kind: "text", text: "Earlier Chief note." }],
      },
      chiefReceipt,
      {
        id: "c-person",
        threadId: "thread-chief",
        seq: 2,
        role: "user",
        botId: chief.id,
        botName: chief.name,
        createdAt: "2026-10-02T10:01:00.000Z",
        blocks: [{ kind: "text", text: "a different request" }],
      },
      {
        id: "c-activity",
        threadId: "thread-chief",
        seq: 3,
        role: "bot",
        runId: "run-chief",
        botId: chief.id,
        botName: chief.name,
        createdAt: "2026-10-02T10:01:30.000Z",
        blocks: [{ kind: "progress", text: "Using shell.", activity: true }],
      },
      {
        id: "c-reply",
        threadId: "thread-chief",
        seq: 4,
        role: "bot",
        runId: "run-chief",
        botId: chief.id,
        botName: chief.name,
        createdAt: "2026-10-02T10:02:00.000Z",
        blocks: [{ kind: "text", text: "Chief on it." }],
      },
      {
        id: "c-later",
        threadId: "thread-chief",
        seq: 5,
        role: "bot",
        runId: "run-other",
        botId: chief.id,
        botName: chief.name,
        createdAt: "2026-10-02T10:03:00.000Z",
        blocks: [{ kind: "text", text: "Later Chief note." }],
      },
    ];
    const deputyThread: Row[] = [
      deputyReceipt,
      {
        id: "d-person",
        threadId: "thread-deputy",
        seq: 2,
        role: "user",
        botId: deputy.id,
        botName: deputy.name,
        createdAt: "2026-10-02T10:01:30.000Z",
        blocks: [{ kind: "text", text: "something else" }],
      },
      {
        id: "d-reply",
        threadId: "thread-deputy",
        seq: 3,
        role: "bot",
        runId: "run-deputy",
        botId: deputy.id,
        botName: deputy.name,
        createdAt: "2026-10-02T10:04:00.000Z",
        blocks: [{ kind: "progress", text: "Deputy on it." }],
      },
    ];
    const loaded = messagesForHubTranscript(chiefThread, deputyThread, {
      messageId: "c-in",
      peerBotId: principal,
    });
    const opened = peerTranscriptForChip(loaded, {
      scope: "hub",
      messageId: "c-in",
      peerBotId: principal,
    });
    expect(hubTranscriptTitle("Chief", opened!)).toBe("Deputy, Chief · Hub · Box Principal");
    expect(opened?.messages.map((turn) => turn.text)).toEqual([
      "Principal to Deputy.",
      "Principal to Chief.",
      "Chief on it.",
      "Deputy on it.",
    ]);
    expect(opened?.messages.map((turn) => turn.text)).not.toContain("Later Chief note.");
    expect(opened?.messages.map((turn) => turn.text)).not.toContain("Earlier Chief note.");
    expect(opened?.messages.map((turn) => turn.text)).not.toContain("Using shell.");
    expect(opened?.messages.map((turn) => turn.text)).not.toContain("a different request");
    expect(loaded.map((message) => message.id)).toContain("d-reply");
  });

  it("loads sibling messages for the anchor key and leaves a missing key on one thread", () => {
    const chiefThread = burst("thread-chief", "c", chief, key);
    const deputyThread = burst("thread-deputy", "d", deputy, key);
    const unrelated: Row = {
      id: "d-other",
      threadId: "thread-deputy",
      seq: 9,
      role: "bot",
      botId: deputy.id,
      botName: deputy.name,
      createdAt: "2026-10-02T12:00:00.000Z",
      blocks: [
        { kind: "hub_message_sent", hubAgentId: lab, name: "OSS Local Lab", text: "later lab" },
      ],
    };
    const loaded = messagesForHubTranscript(chiefThread, [...deputyThread, unrelated], {
      messageId: "c-out-p",
      peerBotId: principal,
    });
    expect(loaded.map((message) => message.id)).toEqual([
      ...chiefThread.map((message) => message.id),
      ...deputyThread.map((message) => message.id),
    ]);
    expect(
      messagesForHubTranscript(burst("thread-chief", "c", chief), deputyThread, {
        messageId: "c-out-p",
        peerBotId: principal,
      }).map((message) => message.id),
    ).toEqual(["c-out-p", "c-out-l", "c-in-p", "c-in-l"]);
  });
});
