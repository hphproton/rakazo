import * as z from "zod";
import { BOT_NAME_MAX_LENGTH, BOT_TITLE_MAX_LENGTH } from "./domain.js";
import { Id } from "./ids.js";

export const HubMemberInputSchema = z.object({
  hubAgentId: z.string().trim().min(1).max(200),
  name: z.string().trim().min(1).max(BOT_NAME_MAX_LENGTH),
  title: z.string().trim().max(BOT_TITLE_MAX_LENGTH).optional(),
});
export type HubMemberInput = z.infer<typeof HubMemberInputSchema>;

export const HubSyncMembersInput = z.object({
  members: z.array(HubMemberInputSchema).max(200),
});
export type HubSyncMembersInput = z.infer<typeof HubSyncMembersInput>;

export const HubDirectoryMemberSchema = z.object({
  hubAgentId: z.string(),
  botId: Id,
  name: z.string(),
  title: z.string(),
  archived: z.boolean(),
});
export type HubDirectoryMember = z.infer<typeof HubDirectoryMemberSchema>;

export const HubDirectoryBotSchema = z.object({
  id: Id,
  name: z.string(),
  title: z.string(),
  archived: z.boolean(),
  spawnKey: z.string().nullable(),
});
export type HubDirectoryBot = z.infer<typeof HubDirectoryBotSchema>;

/** Bidirectional roster snapshot. signature is null until a directory signing key is configured. */
export const HubDirectorySchema = z.object({
  epoch: z.string().min(1),
  issuedAt: z.string().min(1),
  spaceId: Id,
  hubMembers: z.array(HubDirectoryMemberSchema),
  rakazoBots: z.array(HubDirectoryBotSchema),
  signature: z.string().nullable(),
});
export type HubDirectoryDocument = z.infer<typeof HubDirectorySchema>;

export const HubSyncResultSchema = z.object({
  sectionId: Id,
  sectionName: z.literal("Hub"),
  created: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative(),
  archived: z.number().int().nonnegative(),
  directory: HubDirectorySchema,
});
export type HubSyncResult = z.infer<typeof HubSyncResultSchema>;

const HubInboxIntent = z.enum(["request", "result", "question", "status", "fyi"]);

/** One Rakazo → Hub delivery waiting for the host mesh. */
export const HubInboxItemSchema = z.object({
  kind: z.literal("HUB-INBOX"),
  deliveryId: z.string().min(1),
  status: z.enum(["wake", "done"]),
  hubAgentId: z.string().min(1),
  name: z.string(),
  title: z.string(),
  text: z.string(),
  intent: HubInboxIntent,
  threadKey: z.string().min(1).optional(),
  fromBotId: z.string().min(1),
  fromBotName: z.string(),
  spaceId: Id,
  createdAt: z.string().min(1),
  meshId: z.string().min(1).optional(),
});
export type HubInboxItem = z.infer<typeof HubInboxItemSchema>;

export const HubOutboxResultSchema = z.object({
  items: z.array(HubInboxItemSchema),
});
export type HubOutboxResult = z.infer<typeof HubOutboxResultSchema>;

export const HubAckOutboundInput = z.object({
  deliveryIds: z.array(z.string().trim().min(1).max(200)).max(100),
  meshId: z.string().trim().min(1).max(200).optional(),
});
export type HubAckOutboundInput = z.infer<typeof HubAckOutboundInput>;

export const HubAckOutboundResultSchema = z.object({
  ok: z.literal(true),
  acked: z.number().int().nonnegative(),
});
export type HubAckOutboundResult = z.infer<typeof HubAckOutboundResultSchema>;
