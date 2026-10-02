import type { ThreadMessage } from "@rakazo/contracts";
import { hubExchangeForAnchor } from "@rakazo/core";
import { BotAvatar } from "@rakazo/ui-web";
import { createRoot } from "react-dom/client";
import { CollaborationMarker } from "../../src/components/ai/CollaborationMarker";
import { PeerConversationTranscript } from "../../src/pages/PeerMessagesOverlay";
import "../../src/styles.css";

const HUB = "box-principal";
const inbound = "Ship the notes.";
const outbound = "NATIVE_HUB_SEND_SMOKE";

function message(id: string, createdAt: string, blocks: ThreadMessage["blocks"]): ThreadMessage {
  return { id, threadId: "thread-1", seq: 1, role: "bot", blocks, createdAt };
}

const conversation = hubExchangeForAnchor(
  [
    message("in", "2026-10-02T15:00:00.000Z", [
      {
        kind: "bot_message_received",
        fromBotId: HUB,
        fromBotName: "Box Principal",
        origin: "hub",
        text: inbound,
      },
    ]),
    message("out", "2026-10-02T15:05:00.000Z", [
      { kind: "hub_message_sent", hubAgentId: HUB, name: "Box Principal", text: outbound },
    ]),
  ],
  { messageId: "out", peerBotId: HUB },
);

function ChiefThread() {
  return (
    <section
      data-testid="transcript"
      className="flex flex-col gap-2 bg-background px-4 py-5 md:px-7"
    >
      <CollaborationMarker
        ariaLabel="Message from Hub · Box Principal"
        color="#85858A"
        identity={HUB}
        label="Message from Hub · Box Principal"
        onClick={() => undefined}
      />
      <CollaborationMarker
        ariaLabel="To Hub · Box Principal"
        color="#85858A"
        identity={HUB}
        label="To Hub · Box Principal"
        onClick={() => undefined}
      />
      <div className="flex w-fit max-w-full justify-start">
        <div className="max-w-full rounded-[20px] bg-muted px-[18px] py-3 text-[15.5px] leading-[1.5] text-foreground/90">
          Queued for Box Principal.
        </div>
      </div>
    </section>
  );
}

function HubTranscript() {
  if (!conversation) return null;
  return (
    <section
      data-testid="peer-conversation-view"
      className="flex flex-col border-t border-sidebar-border bg-background text-foreground"
    >
      <div className="flex items-center gap-3 border-b border-sidebar-border px-[18px] py-3.5">
        <div className="flex items-center -space-x-2">
          <BotAvatar color="#85858A" identity="chief" size={28} />
          <BotAvatar color="#85858A" identity={HUB} size={28} />
        </div>
        <h1 className="truncate text-[15.5px] font-medium">Chief · Hub · Box Principal</h1>
      </div>
      <PeerConversationTranscript
        botName="Chief"
        peerBotName={conversation.peerBotName}
        messages={conversation.messages}
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
    <HubTranscript />
  </main>,
);
