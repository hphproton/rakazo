import type { ThreadMessage } from "@rakazo/contracts";
import { hubExchangeForAnchor } from "@rakazo/core";
import { BotAvatar } from "@rakazo/ui-web";
import { createRoot } from "react-dom/client";
import { CollaborationMarker } from "../../src/components/ai/CollaborationMarker";
import { PeerConversationTranscript } from "../../src/pages/PeerMessagesOverlay";
import "../../src/styles.css";

const PRINCIPAL = "box-principal";
const LAB = "oss-local-lab";
const COLOR = "#85858A";

function message(
  id: string,
  seq: number,
  createdAt: string,
  blocks: ThreadMessage["blocks"],
  role: ThreadMessage["role"] = "bot",
): ThreadMessage {
  return { id, threadId: "thread-chief", seq, role, blocks, createdAt };
}

const thread = [
  message("ask", 1, "2026-10-02T10:00:00.000Z", [{ kind: "text", text: "Ask both." }], "user"),
  message("to-principal", 2, "2026-10-02T10:01:00.000Z", [
    {
      kind: "hub_message_sent",
      hubAgentId: PRINCIPAL,
      name: "Box Principal",
      text: "Check the deploy.",
    },
  ]),
  message("to-lab", 3, "2026-10-02T10:01:01.000Z", [
    {
      kind: "hub_message_sent",
      hubAgentId: LAB,
      name: "OSS Local Lab",
      text: "Check the lab.",
    },
  ]),
  message("asked", 4, "2026-10-02T10:01:02.000Z", [{ kind: "text", text: "Asked both." }]),
  message(
    "from-principal",
    5,
    "2026-10-02T10:02:00.000Z",
    [
      {
        kind: "bot_message_received",
        fromBotId: PRINCIPAL,
        fromBotName: "Box Principal",
        origin: "hub",
        text: "Principal ready.",
      },
    ],
    "user",
  ),
  message(
    "from-lab",
    6,
    "2026-10-02T10:03:00.000Z",
    [
      {
        kind: "bot_message_received",
        fromBotId: LAB,
        fromBotName: "OSS Local Lab",
        origin: "hub",
        text: "Lab ready.",
      },
    ],
    "user",
  ),
];

const conversation = hubExchangeForAnchor(thread, { messageId: "from-lab", peerBotId: LAB });

function ChiefThread() {
  return (
    <section data-testid="transcript" className="flex flex-col gap-2 bg-background px-4 py-5">
      <CollaborationMarker
        ariaLabel="To Hub · Box Principal"
        color={COLOR}
        identity={PRINCIPAL}
        label="To Hub · Box Principal"
        onClick={() => undefined}
      />
      <CollaborationMarker
        ariaLabel="To Hub · OSS Local Lab"
        color={COLOR}
        identity={LAB}
        label="To Hub · OSS Local Lab"
        onClick={() => undefined}
      />
      <CollaborationMarker
        ariaLabel="Message from Hub · Box Principal"
        color={COLOR}
        identity={PRINCIPAL}
        label="Message from Hub · Box Principal"
        onClick={() => undefined}
      />
      <CollaborationMarker
        ariaLabel="Message from Hub · OSS Local Lab"
        color={COLOR}
        identity={LAB}
        label="Message from Hub · OSS Local Lab"
        onClick={() => undefined}
      />
    </section>
  );
}

function HubTopic() {
  if (!conversation) return null;
  const participants = conversation.participants ?? [];
  return (
    <section
      data-testid="peer-conversation-view"
      className="flex flex-col border-t border-sidebar-border bg-background text-foreground"
    >
      <div className="flex items-center gap-3 border-b border-sidebar-border px-[18px] py-3.5">
        <div className="flex items-center -space-x-2">
          <BotAvatar color={COLOR} identity="chief" size={28} />
          {participants.map((participant) => (
            <BotAvatar
              key={participant.peerBotId}
              color={COLOR}
              identity={participant.peerBotId}
              size={28}
            />
          ))}
        </div>
        <h1 className="truncate text-[15.5px] font-medium">Chief · {conversation.peerBotName}</h1>
      </div>
      <PeerConversationTranscript
        botName="Chief"
        messages={conversation.messages}
        participantCount={participants.length}
      />
      <p className="border-t border-sidebar-border px-[18px] py-3.5 text-[13.5px] text-muted-foreground/80">
        This chat is view-only
      </p>
    </section>
  );
}

createRoot(document.getElementById("root")!).render(
  <main className="min-h-screen bg-background text-foreground">
    <ChiefThread />
    <HubTopic />
  </main>,
);
