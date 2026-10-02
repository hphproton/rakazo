import { ChatMarkdown } from "@rakazo/chat-ui/native";
import type { PeerMessage } from "@rakazo/core";
import { hubExchangeForAnchor } from "@rakazo/core";
import { useEffect, useState } from "react";
import { Modal, Pressable, SafeAreaView, ScrollView, Text, View } from "react-native";
import { type MobileMessage, type MobileMessagePage, rpc } from "../lib/api";
import { mobileTokens } from "../lib/appearance";
import { useI18n } from "../lib/i18n";
import { useResolvedAppearance } from "../lib/native";

/**
 * View-only Hub transcript for the exchange that contains the opened chip.
 * Not every turn with that member, and not the latest exchange. Not a sidebar
 * seat and not a composer.
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
  const [peerBotName, setPeerBotName] = useState(initialPeerBotName);
  const [failed, setFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const abort = new AbortController();
    setTurns(null);
    setFailed(false);
    setPeerBotName(initialPeerBotName);
    void loadBotThread(botId, abort.signal)
      .then((messages) => {
        if (abort.signal.aborted) return;
        const conversation = hubExchangeForAnchor(messages, { messageId, peerBotId });
        setPeerBotName(conversation?.peerBotName ?? initialPeerBotName);
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
  }, [botId, initialPeerBotName, messageId, peerBotId, reloadKey]);

  const title = `${botName} · ${peerBotName}`;

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
                      {sent ? botName : peerBotName}
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
