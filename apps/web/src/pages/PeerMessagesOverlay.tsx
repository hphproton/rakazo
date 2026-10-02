import { Trans, useLingui } from "@lingui/react/macro";
import { ChatMarkdown } from "@rakazo/chat-ui/web";
import type { ThreadMessage } from "@rakazo/contracts";
import { BotAvatar, Button, Dialog, DialogClose, DialogContent, DialogTitle } from "@rakazo/ui-web";
import { useEffect, useMemo, useState } from "react";
import { loadPeerHistory } from "../lib/peer-history";
import type { PeerMessage, PeerParticipant, PeerTranscriptChip } from "../lib/peer-messages";
import {
  hubTranscriptTitle,
  messagesForHubTranscript,
  peerTranscriptForChip,
  peerTurnSpeaker,
  spaceTopicKeyOnAnchor,
} from "../lib/peer-messages";
import { rpc } from "../lib/rpc";

/** Bubbles for one view-only topic. Sent is the Rakazo bot; received is a Hub member or teammate. */
export function PeerConversationTranscript({
  botName,
  messages,
  participantCount = 1,
}: {
  botName: string;
  messages: readonly PeerMessage[];
  participantCount?: number;
}) {
  return (
    <div
      data-testid="peer-conversation-transcript"
      className="rk-scroll flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-4 py-5 md:px-7 md:py-6"
    >
      {messages.map((peerMessage, index) => {
        const sent = peerMessage.direction === "sent";
        return (
          <div
            key={`${peerMessage.messageId}-${index}`}
            data-testid="peer-conversation-turn"
            data-direction={sent ? "sent" : "received"}
            className={`flex ${sent ? "justify-end" : "justify-start"}`}
          >
            <div
              className={`max-w-[80%] rounded-2xl px-4 py-2.5 ${sent ? "bg-accent" : "bg-muted"}`}
            >
              <div className="mb-1 text-[12px] text-muted-foreground/70" dir="auto">
                {peerTurnSpeaker(peerMessage, botName, participantCount)}
              </div>
              <div className="text-[14.5px] leading-[1.5] text-foreground/90" dir="auto">
                <ChatMarkdown>{peerMessage.text}</ChatMarkdown>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Full-screen view-only transcript opened from one chip.
 * A Hub chip opens the topic that contains that chip. One burst can include
 * several Hub members; a 1:1 chip still opens only that exchange. Two Hub
 * members do not require a new page. A shared spaceTopicKey also includes the
 * other Rakazo bot's turns for that key. A teammate chip stays one conversation
 * per bot. There is no composer: delivery stays on hub_send_message, and Hub
 * members are not sidebar seats.
 */
export function PeerMessagesOverlay({
  botId,
  botName,
  botColor,
  peerBotId,
  peerBotName: initialPeerBotName,
  peerBotColor,
  messageId,
  transcriptScope,
  onClose,
}: {
  botId: string;
  botName: string;
  botColor: string;
  peerBotId: string;
  peerBotName: string;
  peerBotColor: string;
  messageId: string;
  transcriptScope: PeerTranscriptChip["scope"];
  onClose: () => void;
}) {
  const { t } = useLingui();
  const [messages, setMessages] = useState<readonly TranscriptMessage[]>([]);
  const [botColors, setBotColors] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [historyReady, setHistoryReady] = useState(false);
  const [historyFailed, setHistoryFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const conversation = useMemo(() => {
    if (!historyReady) return null;
    return peerTranscriptForChip(messages, { scope: transcriptScope, messageId, peerBotId });
  }, [historyReady, messageId, messages, peerBotId, transcriptScope]);
  const peerBotName = conversation?.peerBotName ?? initialPeerBotName;
  const participants: readonly PeerParticipant[] = conversation?.participants ?? [];
  const participantCount = participants.length > 1 ? participants.length : 1;
  const spaceBots = conversation?.rakazoBots ?? [];

  useEffect(() => {
    const abort = new AbortController();
    setHistoryReady(false);
    setHistoryFailed(false);
    setMessages([]);
    void loadHubChipTranscript({
      signal: abort.signal,
      botId,
      botName,
      messageId,
      peerBotId,
      transcriptScope,
    })
      .then((loaded) => {
        if (abort.signal.aborted) return;
        setBotColors(loaded.colors);
        setMessages(loaded.messages);
        setHistoryReady(true);
      })
      .catch(() => {
        if (abort.signal.aborted) return;
        setHistoryFailed(true);
        setHistoryReady(true);
      });
    return () => {
      abort.abort();
    };
  }, [botId, botName, messageId, peerBotId, reloadKey, transcriptScope]);

  const title = conversation
    ? hubTranscriptTitle(botName, conversation)
    : `${botName} · ${initialPeerBotName}`;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        data-testid="peer-conversation-view"
        showCloseButton={false}
        className="inset-0 top-0 left-0 flex h-full w-full max-w-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none bg-background p-0 text-foreground ring-0 sm:max-w-none"
      >
        <div className="flex items-center justify-between gap-4 border-b border-sidebar-border px-[18px] py-3.5">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <div className="flex items-center -space-x-2">
              {spaceBots.length > 1 ? (
                spaceBots.map((bot) => (
                  <BotAvatar
                    key={bot.botId}
                    color={bot.botId === botId ? botColor : (botColors.get(bot.botId) ?? botColor)}
                    identity={bot.botId}
                    size={28}
                  />
                ))
              ) : (
                <BotAvatar color={botColor} identity={botId} size={28} />
              )}
              {participants.length > 1 ? (
                participants.map((participant) => (
                  <BotAvatar
                    key={participant.peerBotId}
                    color={peerBotColor}
                    identity={participant.peerBotId}
                    size={28}
                  />
                ))
              ) : (
                <BotAvatar color={peerBotColor} identity={peerBotId} size={28} />
              )}
            </div>
            <DialogTitle className="truncate text-[15.5px] font-medium text-foreground" dir="auto">
              {title}
            </DialogTitle>
          </div>
          <DialogClose aria-label={t`Close`} render={<Button variant="ghost" size="sm" />}>
            <Trans>Close</Trans>
          </DialogClose>
        </div>

        {!historyReady ? (
          <div className="grid flex-1 place-items-center px-8 text-center text-[13.5px] text-muted-foreground/80">
            <Trans>Loading…</Trans>
          </div>
        ) : historyFailed ? (
          <div className="grid flex-1 place-items-center px-8 text-center text-[13.5px] text-muted-foreground/80">
            <div className="flex flex-col items-center gap-3">
              <Trans>Could not load this chat.</Trans>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setReloadKey((value) => value + 1)}
              >
                <Trans>Retry now</Trans>
              </Button>
            </div>
          </div>
        ) : !conversation || conversation.messages.length === 0 ? (
          <div className="grid flex-1 place-items-center px-8 text-center text-[13.5px] text-muted-foreground/80">
            <Trans>No messages with {peerBotName} yet.</Trans>
          </div>
        ) : (
          <PeerConversationTranscript
            botName={botName}
            messages={conversation.messages}
            participantCount={participantCount}
          />
        )}

        <div className="flex items-center gap-4 border-t border-sidebar-border px-[18px] py-3.5">
          <p className="text-[13.5px] text-muted-foreground/80">
            <Trans>This chat is view-only</Trans>
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}

type TranscriptMessage = ThreadMessage & { botName?: string };

/**
 * The opened bot's thread. When that chip's Hub block has a spaceTopicKey,
 * also load other bots' turns that carry the same key. No key stays on this thread.
 * A failed sibling load still opens the bot's own topic.
 */
async function loadHubChipTranscript({
  signal,
  botId,
  botName,
  messageId,
  peerBotId,
  transcriptScope,
}: {
  signal: AbortSignal;
  botId: string;
  botName: string;
  messageId: string;
  peerBotId: string;
  transcriptScope: PeerTranscriptChip["scope"];
}): Promise<{ messages: TranscriptMessage[]; colors: ReadonlyMap<string, string> }> {
  const own = await loadPeerHistory({
    signal,
    loadPage: (before, pageSignal) =>
      rpc.threads.messages({ botId, before, includePeerRuns: true }, { signal: pageSignal }),
  });
  const stampedOwn = own.map((message) => ({ ...message, botId, botName }));
  const anchor = { messageId, peerBotId };
  if (transcriptScope !== "hub" || !spaceTopicKeyOnAnchor(stampedOwn, anchor)) {
    return { messages: stampedOwn, colors: new Map() };
  }
  try {
    const bots = await rpc.bots.list(undefined, { signal });
    if (signal.aborted) return { messages: stampedOwn, colors: new Map() };
    const settled = await Promise.allSettled(
      bots
        .filter((bot) => bot.id !== botId)
        .map(async (bot) => {
          const page = await loadPeerHistory({
            signal,
            loadPage: (before, pageSignal) =>
              rpc.threads.messages(
                { botId: bot.id, before, includePeerRuns: true },
                { signal: pageSignal },
              ),
          });
          return page.map((message) => ({ ...message, botId: bot.id, botName: bot.name }));
        }),
    );
    if (signal.aborted) return { messages: stampedOwn, colors: new Map() };
    const siblings = settled.flatMap((result) =>
      result.status === "fulfilled" ? result.value : [],
    );
    return {
      messages: messagesForHubTranscript(stampedOwn, siblings, anchor),
      colors: new Map(bots.map((bot) => [bot.id, bot.color])),
    };
  } catch {
    if (signal.aborted) return { messages: stampedOwn, colors: new Map() };
    return { messages: stampedOwn, colors: new Map() };
  }
}
