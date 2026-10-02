import type { ThreadMessage } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { isTrivialHubAckText, userVisibleMessages } from "./message-visibility.js";

function message(id: string, runId: string, blocks: ThreadMessage["blocks"]): ThreadMessage {
  return {
    id,
    threadId: "thread-1",
    seq: 1,
    role: "bot",
    blocks,
    runId,
    createdAt: "2026-08-30T22:00:00.000Z",
  };
}

const peerExchange = [
  message("user", "run-user", [{ kind: "text", text: "Please ask Coder." }]),
  message("sent", "run-user", [
    { kind: "bot_message_sent", toBotId: "coder", toBotName: "Coder", text: "Check this." },
  ]),
  message("received", "run-peer", [
    {
      kind: "bot_message_received",
      fromBotId: "coder",
      fromBotName: "Coder",
      text: "Done.",
    },
  ]),
  message("activity", "run-peer", [{ kind: "steps", steps: [{ label: "Message bot", count: 1 }] }]),
  message("reply", "run-peer", [{ kind: "text", text: "Sent Coder the endpoints." }]),
  message("answer", "run-user", [{ kind: "text", text: "Coder is checking it." }]),
];

describe("user-visible messages", () => {
  it("hides peer activity but keeps the bot's text reply to the user", () => {
    expect(userVisibleMessages(peerExchange).map((item) => item.id)).toEqual([
      "user",
      "reply",
      "answer",
    ]);
  });

  it("keeps compact peer receipts when includePeerReceipts is set", () => {
    expect(
      userVisibleMessages(peerExchange, { includePeerReceipts: true }).map((item) => item.id),
    ).toEqual(["user", "sent", "received", "reply", "answer"]);
  });

  it("uses authoritative peer run ids when the receipt is outside the loaded page", () => {
    const messages = [
      message("activity", "run-peer", [
        { kind: "steps", steps: [{ label: "Echoed peer reply", count: 1 }] },
      ]),
      message("reply", "run-peer", [{ kind: "text", text: "Echoed peer reply" }]),
      message("answer", "run-user", [{ kind: "text", text: "Visible answer" }]),
    ];

    expect(
      userVisibleMessages(messages, { knownPeerRunIds: ["run-peer"] }).map((item) => item.id),
    ).toEqual(["reply", "answer"]);
  });

  it("shows a Hub receipt without hiding the target bot's turn", () => {
    const messages = [
      message("hub", "run-hub", [
        {
          kind: "bot_message_received",
          fromBotId: "hub-atlas",
          fromBotName: "Atlas",
          origin: "hub",
          text: "Check the deploy.",
        },
      ]),
      message("steps", "run-hub", [
        { kind: "steps", steps: [{ label: "Look up deploy", count: 1 }] },
      ]),
      message("reply", "run-hub", [{ kind: "text", text: "Deploy is green." }]),
    ];
    expect(
      userVisibleMessages(messages, { includePeerReceipts: true }).map((item) => item.id),
    ).toEqual(["hub", "steps", "reply"]);
    expect(userVisibleMessages(messages).map((item) => item.id)).toEqual(["steps", "reply"]);
  });

  it("hides a bare Hub acknowledgement and keeps a substantive relay", () => {
    const hub = {
      ...message("hub", "run-hub", [
        {
          kind: "bot_message_received",
          fromBotId: "hub-atlas",
          fromBotName: "Atlas",
          origin: "hub",
          text: "Please ACK.",
        },
      ]),
      seq: 12,
      role: "user" as const,
    };
    const messages = [
      hub,
      { ...message("ack", "run-hub", [{ kind: "text", text: "OK." }]), seq: 13 },
      { ...message("ack-word", "run-hub", [{ kind: "text", text: "  **ACK**  " }]), seq: 14 },
      {
        ...message("substance", "run-hub", [{ kind: "text", text: "Deploy is green." }]),
        seq: 15,
      },
      {
        ...message("substance-ack", "run-hub", [{ kind: "text", text: "OK. Deploy is green." }]),
        seq: 16,
      },
      {
        ...message("user-ok", "run-hub", [{ kind: "text", text: "OK." }]),
        seq: 17,
        role: "user" as const,
      },
      {
        ...message("before", "run-hub", [{ kind: "text", text: "OK." }]),
        seq: 11,
      },
      {
        ...message("steps-ok", "run-hub", [
          { kind: "steps", steps: [{ label: "Look up deploy", count: 1 }] },
          { kind: "text", text: "OK." },
        ]),
        seq: 18,
      },
    ];

    expect(
      userVisibleMessages(messages, { includePeerReceipts: true }).map((item) => item.id),
    ).toEqual(["hub", "substance", "substance-ack", "user-ok", "before", "steps-ok"]);
    expect(
      userVisibleMessages([...messages].reverse(), { includePeerReceipts: true }).map(
        (item) => item.id,
      ),
    ).toEqual(["steps-ok", "before", "user-ok", "substance-ack", "substance", "hub"]);
  });

  it("does not hide a bare acknowledgement on a turn the user started", () => {
    const messages = [
      message("user", "run-user", [{ kind: "text", text: "You there?" }]),
      message("reply", "run-user", [{ kind: "text", text: "OK." }]),
    ];
    expect(userVisibleMessages(messages).map((item) => item.id)).toEqual(["user", "reply"]);
  });

  it("keeps a teammate acknowledgement that answers the user", () => {
    const messages = [
      message("received", "run-peer", [
        {
          kind: "bot_message_received",
          fromBotId: "coder",
          fromBotName: "Coder",
          text: "Done.",
        },
      ]),
      message("reply", "run-peer", [{ kind: "text", text: "OK." }]),
    ];
    expect(
      userVisibleMessages(messages, { includePeerReceipts: true }).map((item) => item.id),
    ).toEqual(["received", "reply"]);
  });

  it("hides Hub narration that is only an acknowledgement", () => {
    const messages = [
      {
        ...message("hub", "run-hub", [
          {
            kind: "bot_message_received",
            fromBotId: "hub-atlas",
            fromBotName: "Atlas",
            origin: "hub",
            text: "Ping.",
          },
        ]),
        seq: 1,
        role: "user" as const,
      },
      {
        ...message("narration", "run-hub", [{ kind: "progress", text: "OK." }]),
        seq: 2,
      },
      {
        ...message("work", "run-hub", [
          { kind: "progress", text: "Checking the deploy.", activity: true },
        ]),
        seq: 3,
      },
    ];
    expect(
      userVisibleMessages(messages, { includePeerReceipts: true }).map((item) => item.id),
    ).toEqual(["hub", "work"]);
  });

  it("recognizes receipt-only text and leaves substance alone", () => {
    expect(isTrivialHubAckText("OK.")).toBe(true);
    expect(isTrivialHubAckText("ACK")).toBe(true);
    expect(isTrivialHubAckText("Okay!")).toBe(true);
    expect(isTrivialHubAckText("Acknowledged.")).toBe(true);
    expect(isTrivialHubAckText("OK.\nACK")).toBe(true);
    expect(isTrivialHubAckText("OK. Deploy is green.")).toBe(false);
    expect(isTrivialHubAckText("Done.")).toBe(false);
  });

  it("keeps a peer-run ask card and text reply while hiding other peer activity", () => {
    const messages = [
      message("ask", "run-peer", [
        {
          kind: "ask",
          text: "Pick one",
          status: "pending",
          actions: [{ id: "a", label: "A" }],
        },
      ]),
      message("activity", "run-peer", [{ kind: "steps", steps: [{ label: "Work", count: 1 }] }]),
      message("reply", "run-peer", [{ kind: "text", text: "Peer body" }]),
      message("answer", "run-user", [{ kind: "text", text: "Visible answer" }]),
    ];

    expect(
      userVisibleMessages(messages, { knownPeerRunIds: ["run-peer"] }).map((item) => item.id),
    ).toEqual(["ask", "reply", "answer"]);
  });
});
