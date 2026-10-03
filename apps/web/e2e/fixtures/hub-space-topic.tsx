import type { ThreadMessage } from "@rakazo/contracts";
import {
  hubChipBlockKey,
  hubExchangeForAnchor,
  hubMemberLabel,
  hubTopicChipPlan,
  hubTranscriptTitle,
} from "@rakazo/core";
import { BotAvatar } from "@rakazo/ui-web";
import { createRoot } from "react-dom/client";
import { CollaborationMarker } from "../../src/components/ai/CollaborationMarker";
import { PeerConversationTranscript } from "../../src/pages/PeerMessagesOverlay";
import "../../src/styles.css";

const PRINCIPAL = "box-principal";
const LAB = "oss-local-lab";
const KEY = "burst-1";
const COLOR = "#85858A";

type Row = ThreadMessage & { botName?: string };

function row(
  id: string,
  threadId: string,
  seq: number,
  createdAt: string,
  blocks: ThreadMessage["blocks"],
  bot: { id: string; name: string },
  role: ThreadMessage["role"] = "bot",
): Row {
  return {
    id,
    threadId,
    seq,
    role,
    createdAt,
    botId: bot.id,
    botName: bot.name,
    blocks: blocks.map((block) => ({ ...block, spaceTopicKey: KEY })),
  };
}

const chief = { id: "bot-chief", name: "Chief" };
const deputy = { id: "bot-deputy", name: "Deputy" };

const chiefThread = [
  row(
    "c-out-p",
    "thread-chief",
    1,
    "2026-10-02T10:00:00.000Z",
    [
      {
        kind: "hub_message_sent",
        hubAgentId: PRINCIPAL,
        name: "Box Principal",
        text: "Check the deploy.",
      },
    ],
    chief,
  ),
  row(
    "c-out-l",
    "thread-chief",
    2,
    "2026-10-02T10:01:00.000Z",
    [{ kind: "hub_message_sent", hubAgentId: LAB, name: "OSS Local Lab", text: "Check the lab." }],
    chief,
  ),
  row(
    "c-in-p",
    "thread-chief",
    3,
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
    chief,
    "user",
  ),
  row(
    "c-in-l",
    "thread-chief",
    4,
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
    chief,
    "user",
  ),
  row(
    "c-reply",
    "thread-chief",
    5,
    "2026-10-02T10:04:00.000Z",
    [{ kind: "text", text: "Chief on it." }],
    chief,
  ),
];

const deputyThread = [
  row(
    "d-out-p",
    "thread-deputy",
    1,
    "2026-10-02T10:00:00.000Z",
    [
      {
        kind: "hub_message_sent",
        hubAgentId: PRINCIPAL,
        name: "Box Principal",
        text: "Deputy deploy.",
      },
    ],
    deputy,
  ),
  row(
    "d-out-l",
    "thread-deputy",
    2,
    "2026-10-02T10:01:00.000Z",
    [{ kind: "hub_message_sent", hubAgentId: LAB, name: "OSS Local Lab", text: "Deputy lab." }],
    deputy,
  ),
  row(
    "d-in-p",
    "thread-deputy",
    3,
    "2026-10-02T10:02:00.000Z",
    [
      {
        kind: "bot_message_received",
        fromBotId: PRINCIPAL,
        fromBotName: "Box Principal",
        origin: "hub",
        text: "Principal to Deputy.",
      },
    ],
    deputy,
    "user",
  ),
  row(
    "d-in-l",
    "thread-deputy",
    4,
    "2026-10-02T10:03:00.000Z",
    [
      {
        kind: "bot_message_received",
        fromBotId: LAB,
        fromBotName: "OSS Local Lab",
        origin: "hub",
        text: "Lab to Deputy.",
      },
    ],
    deputy,
    "user",
  ),
  row(
    "d-reply",
    "thread-deputy",
    5,
    "2026-10-02T10:05:00.000Z",
    [{ kind: "text", text: "Deputy on it." }],
    deputy,
  ),
];

function familyLabel(direction: "sent" | "received", names: readonly string[]): string {
  const summary = names.join(", ");
  return direction === "sent" ? `To Hub · ${summary}` : `Message from ${hubMemberLabel(summary)}`;
}

function ThreadChips({ testId, thread }: { testId: string; thread: readonly Row[] }) {
  const plan = hubTopicChipPlan(thread);
  const chips: Array<{ key: string; identity: string; label: string }> = [];
  for (const entry of thread) {
    for (const block of entry.blocks) {
      if (block.kind === "hub_message_sent") {
        const key = hubChipBlockKey(entry.id, block.hubAgentId, "sent");
        const family = plan.families.get(key);
        if (family) {
          chips.push({
            key,
            identity: family.peerBotId,
            label: familyLabel(family.direction, family.names),
          });
        }
        continue;
      }
      if (block.kind === "bot_message_received" && block.origin === "hub") {
        const key = hubChipBlockKey(entry.id, block.fromBotId, "received");
        const family = plan.families.get(key);
        if (family) {
          chips.push({
            key,
            identity: family.peerBotId,
            label: familyLabel(family.direction, family.names),
          });
        }
      }
    }
  }
  return (
    <section data-testid={testId} className="flex flex-col gap-2 bg-background px-4 py-5">
      {chips.map((chip) => (
        <CollaborationMarker
          key={chip.key}
          ariaLabel={chip.label}
          color={COLOR}
          identity={chip.identity}
          label={chip.label}
          onClick={() => undefined}
        />
      ))}
    </section>
  );
}

const conversation = hubExchangeForAnchor([...chiefThread, ...deputyThread], {
  messageId: "c-out-p",
  peerBotId: PRINCIPAL,
});

function SpaceTopic() {
  if (!conversation) return null;
  const participants = conversation.participants ?? [];
  const title = hubTranscriptTitle("Chief", conversation);
  return (
    <section
      data-testid="peer-conversation-view"
      className="flex flex-col border-t border-sidebar-border bg-background text-foreground"
    >
      <div className="flex items-center gap-3 border-b border-sidebar-border px-[18px] py-3.5">
        <div className="flex items-center -space-x-2">
          <BotAvatar color={COLOR} identity="bot-chief" size={28} />
          <BotAvatar color={COLOR} identity="bot-deputy" size={28} />
          {participants.map((participant) => (
            <BotAvatar
              key={participant.peerBotId}
              color={COLOR}
              identity={participant.peerBotId}
              size={28}
            />
          ))}
        </div>
        <h1 className="truncate text-[15.5px] font-medium">{title}</h1>
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
    <ThreadChips testId="chief-thread" thread={chiefThread} />
    <ThreadChips testId="deputy-thread" thread={deputyThread} />
    <SpaceTopic />
  </main>,
);
