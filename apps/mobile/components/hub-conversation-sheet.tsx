import { ChatMarkdown } from "@rakazo/chat-ui/native";
import type { HubTranscriptBot, PeerMessage } from "@rakazo/core";
import {
  hubExchangeForAnchor,
  hubTranscriptTitle,
  messagesForHubTranscript,
  peerTurnSpeaker,
  spaceTopicKeyOnAnchor,
} from "@rakazo/core";
import { useEffect, useState } from "react";
import { Modal, Pressable, SafeAreaView, ScrollView, Text, View } from "react-native";
import { type MobileBot, type MobileMessage, type MobileMessagePage, rpc } from "../lib/api";
import { mobileTokens } from "../lib/appearance";
import { useI18n } from "../lib/i18n";
import { useResolvedAppearance } from "../lib/native";

/**
 * View-only Hub topic for the chip that was opened. One burst can include
 * several Hub members. A 1:1 chip still opens only that exchange. A shared
 * spaceTopicKey also includes the other Rakazo bot. Not a sidebar seat and
 * not a composer.
 */
export function HubConversationSheet({
  botId,
  botName,
  peerBotId,
  peerBotName: initialPeerBotName,
  messageId,
  onClose,
}: {
  botId: string;
  botName: string;
  peerBotId: string;
  peerBotName: string;
  messageId: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const colorScheme = useResolvedAppearance();
  const tokens = mobileTokens();
  const [turns, setTurns] = useState<PeerMessage[] | null>(null);
  const [participantCount, setParticipantCount] = useState(1);
  const [peerBotName, setPeerBotName] = useState(initialPeerBotName);
  const [rakazoBots, setRakazoBots] = useState<readonly HubTranscriptBot[]>([]);
  const [failed, setFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const abort = new AbortController();
    setTurns(null);
    setFailed(false);
    setParticipantCount(1);
    setPeerBotName(initialPeerBotName);
    setRakazoBots([]);
    void loadSpaceTopic(botId, botName, messageId, peerBotId, abort.signal)
      .then((messages) => {
        if (abort.signal.aborted) return;
        const conversation = hubExchangeForAnchor(messages, { messageId, peerBotId });
        setPeerBotName(conversation?.peerBotName ?? initialPeerBotName);
        setParticipantCount(conversation?.participants?.length ?? 1);
        setRakazoBots(conversation?.rakazoBots ?? []);
        setTurns(conversation?.messages ?? []);
      })
      .catch(() => {
        if (abort.signal.aborted) return;
        setFailed(true);
        setTurns([]);
      });
    return () => {
      abort.abort();
    };
  }, [botId, botName, initialPeerBotName, messageId, peerBotId, reloadKey]);

  const title = hubTranscriptTitle(botName, { peerBotName, rakazoBots });

  return (
    <Modal animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView style={{ flex: 1, backgroundColor: tokens.background }}>
        <View
          style={{
            minHeight: 54,
            flexDirection: "row",
            alignItems: "center",
            gap: 12,
            borderBottomWidth: 1,
            borderBottomColor: tokens.border,
            paddingHorizontal: 16,
            paddingVertical: 10,
          }}
        >
          <Text
            numberOfLines={1}
            style={{ flex: 1, color: tokens.foreground, fontSize: 16, fontWeight: "500" }}
          >
            {title}
          </Text>
          <Pressable accessibilityRole="button" accessibilityLabel={t("Close")} onPress={onClose}>
            <Text style={{ color: tokens.foreground, fontSize: 16 }}>{t("Close")}</Text>
          </Pressable>
        </View>
        {turns === null ? (
          <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
            <Text style={{ color: tokens.mutedForeground, fontSize: 14 }}>{t("Loading…")}</Text>
          </View>
        ) : failed ? (
          <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24 }}>
            <Pressable
              accessibilityRole="button"
              onPress={() => setReloadKey((value) => value + 1)}
            >
              <Text style={{ color: tokens.mutedForeground, fontSize: 14, textAlign: "center" }}>
                {t("Could not load earlier messages")}
              </Text>
            </Pressable>
          </View>
        ) : (
          <ScrollView contentContainerStyle={{ padding: 16, gap: 10 }}>
            {turns.map((turn, index) => {
              const sent = turn.direction === "sent";
              return (
                <View
                  key={`${turn.messageId}-${index}`}
                  style={{ alignItems: sent ? "flex-end" : "flex-start" }}
                >
                  <View
                    style={{
                      maxWidth: "80%",
                      borderRadius: 16,
                      backgroundColor: sent ? tokens.accent : tokens.muted,
                      paddingHorizontal: 14,
                      paddingVertical: 10,
                    }}
                  >
                    <Text style={{ color: tokens.mutedForeground, fontSize: 12, marginBottom: 4 }}>
                      {peerTurnSpeaker(turn, botName, participantCount)}
                    </Text>
                    <ChatMarkdown palette={tokens} colorScheme={colorScheme}>
                      {turn.text}
                    </ChatMarkdown>
                  </View>
                </View>
              );
            })}
          </ScrollView>
        )}
        <View
          style={{
            borderTopWidth: 1,
            borderTopColor: tokens.border,
            paddingHorizontal: 16,
            paddingVertical: 12,
          }}
        >
          <Text style={{ color: tokens.mutedForeground, fontSize: 13 }}>
            {t("This chat is view-only")}
          </Text>
        </View>
      </SafeAreaView>
    </Modal>
  );
}

async function loadSpaceTopic(
  botId: string,
  botName: string,
  messageId: string,
  peerBotId: string,
  signal: AbortSignal,
): Promise<Array<MobileMessage & { botName?: string }>> {
  const own = (await loadBotThread(botId, signal)).map((message) => ({
    ...message,
    botId,
    botName,
  }));
  const anchor = { messageId, peerBotId };
  if (!spaceTopicKeyOnAnchor(own, anchor)) return own;
  try {
    const bots = await rpc<MobileBot[]>("bots/list", {}, { signal });
    if (signal.aborted) return own;
    const settled = await Promise.allSettled(
      bots
        .filter((bot) => bot.id !== botId)
        .map(async (bot) => {
          const page = await loadBotThread(bot.id, signal);
          return page.map((message) => ({ ...message, botId: bot.id, botName: bot.name }));
        }),
    );
    if (signal.aborted) return own;
    const siblings = settled.flatMap((result) =>
      result.status === "fulfilled" ? result.value : [],
    );
    return messagesForHubTranscript(own, siblings, anchor);
  } catch {
    return own;
  }
}

async function loadBotThread(botId: string, signal: AbortSignal): Promise<MobileMessage[]> {
  let before: number | undefined;
  let collected: MobileMessage[] = [];
  for (let page = 0; page < 50; page += 1) {
    const result = await rpc<MobileMessagePage>(
      "threads/messages",
      { botId, ...(before === undefined ? {} : { before }), includePeerRuns: true },
      { signal, timeoutMs: 15_000 },
    );
    collected = [...result.messages, ...collected];
    if (result.olderCursor == null) return collected;
    before = result.olderCursor;
  }
  return collected;
}
