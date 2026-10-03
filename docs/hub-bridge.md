# Hub bridge

Hub and Rakazo share a roster through the signed-in API. Session cookie or `Authorization: Bearer`, same as other procedures. The caller's current space is the boundary. Better Auth and Spaces stay as they are.

This is not an ExternalConversation messaging provider, and it does not embed a bot in another product's sidebar.

## Hub members on the roster

`POST /rpc/hub/syncMembers`

```json
{
  "json": {
    "members": [
      { "hubAgentId": "hub-atlas", "name": "Atlas", "title": "Deploy" }
    ]
  }
}
```

The body is a full snapshot. Each member is stored as a directory row with spawn key `hub:<hubAgentId>` in a section named Hub. That section and those rows are not chats. Member lists, the sidebar, search, and activity omit them, and `message_bot` cannot target them. The same Hub id keeps the same bot id, including after it was archived. Members left out of the snapshot are archived. Workspace bots are not archived. The call does not start an intro run.

Response: `{ sectionId, sectionName, created, updated, archived, directory }`.

## Directory

`POST /rpc/hub/directory`

```json
{ "json": {} }
```

Response:

```json
{
  "json": {
    "epoch": "<content epoch>",
    "issuedAt": "<ISO time>",
    "spaceId": "<space id>",
    "hubMembers": [
      { "hubAgentId": "hub-atlas", "botId": "<bot id>", "name": "Atlas", "title": "Deploy", "archived": false }
    ],
    "rakazoBots": [
      { "id": "<bot id>", "name": "Chief", "title": "", "archived": false, "spawnKey": null }
    ],
    "signature": null
  }
}
```

`epoch` changes only when that snapshot changes. A later read of the same roster keeps the same epoch. `hubMembers` are keyed by Hub agent id. `rakazoBots` are keyed by bot id. Instructions, model settings, and webhook secrets are not included.

`signature` is hex HMAC-SHA256 over the canonical JSON of `epoch`, `spaceId`, `hubMembers`, and `rakazoBots` when `HUB_DIRECTORY_SIGNING_KEY` is set. Otherwise it is null. The call still requires a signed-in session. `issuedAt` is not part of the signature.

## Inbound cutover

Hub → Rakazo uses `POST /rpc/threads/receiveHub`. Pass exactly one of `botId` or `groupId`. A `botId` stores a peer receipt and wakes that bot with trigger `hub_message`. A `groupId` with no `botId` uses the same mention rule as a person message in the group. Named members and `@everyone` select those members. When the text names nobody, the first member is selected. One selected member stores the receipt (`bot_message_received`, `origin` `hub`) on the ChatGroup thread and wakes that member there. More than one selected member does not stay as one group chip: each bot gets that receipt on their own thread and wakes there, one 1:1 chip per bot. A caller does not need the member bot ids.

```json
{
  "json": {
    "botId": "<target bot id>",
    "hubAgentId": "hub-atlas",
    "hubAgentName": "Atlas",
    "text": "Deploy the staging build.",
    "spaceTopicKey": "burst-1"
  }
}
```

```json
{
  "json": {
    "groupId": "<chat group id>",
    "hubAgentId": "hub-atlas",
    "hubAgentName": "Atlas",
    "text": "Deploy the staging build.",
    "spaceTopicKey": "burst-1"
  }
}
```

`spaceTopicKey` is optional, at most 200 characters, on a bot or a group delivery. The same value on each bot joins that burst. Omit it and the delivery stays on that bot's thread. A one-member group delivery stores the key on the group-thread receipt. A delivery that wakes more than one bot stores the same key on each bot's receipt. It is not `clientNonce`, and it is not `threadKey`.

`threads/send` remains a person typing. A bot webhook whose JSON has `origin` `hub`, `event` `hub_message`, or both `hubAgentId` and `hubAgentName` responds `409` with `Hub inbound uses threads/receiveHub` and does not store a user message. Other webhook bodies are unchanged.

## Rakazo to Hub

A Rakazo bot delivers with the builtin tool `hub_send_message`. The user does not type `TO_HUB:`. Writing `TO_HUB:` in a reply does not send. The tool resolves a Hub member from the same directory rows as `hub/directory` (`spawnKey` `hub:<hubAgentId>`), by explicit id or by name and title. It does not require `hub/syncMembers` or a visible Hub sidebar section.

The tool writes a `HUB-INBOX` row with status `wake` and a `hub_message_sent` message in the sending thread. A run on a ChatGroup thread echoes on that group thread. When that call omits `threadKey`, the row stores the ChatGroup id in `threadKey` so the mesh can see which group sent it. A caller-supplied `threadKey` is kept. `threadKey` is not a space topic key, and storing the group id does not drop `spaceTopicKey` from the echo. The outbox has no `groupId` column.

That row is a Hub chip in the same family as an inbound receipt (`Message from Hub · {name}`): avatar, pill, left alignment, and no payload bubble in the bot thread. The label is `To Hub · {name}`. When one topic includes more than one Hub member, the thread collapses each direction that has more than one turn into a single chip. The sends share `To Hub · Box Principal, OSS Local Lab`. The replies share `Message from Hub · Box Principal, OSS Local Lab`. A topic with one member still shows `To Hub · {name}` and `Message from Hub · {name}` as separate chips. The stored blocks stay; this only changes which chips the thread draws. Either chip opens the view-only topic that contains that chip. A topic is one stretch on one bot thread. Several `hub_send_message` calls before the bot writes a reply share it, and so do inbound receipts from those members. A burst of receipts from several Hub agents, with no bot reply between them, is the same kind of topic. The header lists every member (`{bot} · Hub · Box Principal, OSS Local Lab`). Each turn names its speaker. An outbound in that topic is `{bot} · Hub · {name}` so the sends stay distinct. A topic with one member keeps the 1:1 labels.

A person message — a user row that is not itself a Hub or teammate receipt — ends every open topic on that thread. For a single member, a bot text reply still starts a new topic when the next Hub turn repeats a direction already present, or the topic already has both directions. The missing direction still joins after that reply, so an inbound receipt and the outbound that answers it stay one transcript. That written reply is itself a turn on the topic it answers, on the bot's own page and on a shared space topic. A bare acknowledgement the thread already hides, such as "OK.", stays off the transcript. A different Hub member who starts only after that reply gets their own topic, so two 1:1s in a row stay apart. An older chip does not open a later topic. If the clicked message is not in the loaded thread, the view stays empty and does not substitute the latest topic. An optional `spaceTopicKey` on the Hub block is the only join across Rakazo bots. The answering `hub_send_message` echo copies that key when the run's open topic on that thread already has one, and does not invent one. `threadKey` on the outbox row is still not copied onto the echo. `clientNonce` is not the key. With no `spaceTopicKey`, each bot thread keeps its own topic. Messaging two Hub members does not require one shared page; separate 1:1 topics stay valid. The person does not type in the transcript. Delivery stays this tool, then the outbox, then the mesh. The outbox row is the first-party drain. This tip has no separate native outbound sender, so cutover still reports `rakazoToHub` `mcp`: a host-straight mesh reads the outbox instead of scraping a `TO_HUB:` user message.

The transcript is not a Hub seat. Directory rows stay out of the sidebar, search, and `message_bot`. Web loads that bot's thread (`threads/messages` with peer runs) and selects the topic for the clicked message. Mobile does the same from either Hub chip. A second Rakazo bot stays on its own transcript unless both sides carry the same `spaceTopicKey`. Opening a chip then includes the other bot's Hub turns for that key, and each bot's written reply to those receipts, in the existing view-only transcript. The header names both Rakazo bots and the Hub members. Each turn keeps its speaker. A reply is that bot's name. Chips stay on the bot thread that stored them, at most two for a multi-member burst, and never one chip that spans bots. A Hub message that wakes more than one bot is one chip on each bot's thread. There is still no space-wide Hub inbox, no live update while the view is open, and no composer.

## Lab smoke: multi-party topic

One Rakazo bot. Two Hub members, for example Box Principal and OSS Local Lab.

1. Send a person message on that bot asking both.
2. In the same turn, before the bot writes a reply, call `hub_send_message` once for Box Principal and once for OSS Local Lab.
3. Deliver each reply with `threads/receiveHub` on that same bot, before the next person message.
4. The thread shows two chips for that burst, not one per leg: `To Hub · Box Principal, OSS Local Lab` and `Message from Hub · Box Principal, OSS Local Lab`. Open either.

The view is one topic. Both chips open it. Both sends and both replies are interleaved. The header reads `{bot} · Hub · Box Principal, OSS Local Lab`. Each reply shows its Hub name. The footer stays `This chat is view-only`. There is no composer. Hub members stay out of the sidebar.

A chip from a 1:1 that the person message already closed still opens only that 1:1. A Hub member addressed only after the bot has replied stays on their own topic.

## Space-wide topic

Optional. Two Rakazo bots share the existing view-only transcript only when each Hub block carries the same `spaceTopicKey`.

1. Deliver the burst to each bot with `threads/receiveHub` and that key.
2. Each bot's answering `hub_send_message` echoes the key while its own topic is still open. A person message on one bot does not close the other bot's topic.
3. Each bot thread still shows at most two chips for a multi-member burst. Open either chip.

The transcript lists both bots' Hub turns for that key and each bot's written reply. A reply that exists only in the bot chat is not enough; it is on this page too. A burst with no key stays on the bot thread that stored it, even when the texts and timestamps match. Two Hub members can stay on separate 1:1 topics. This does not add a space inbox or a composer.

The Hub directory prompt and the `message_bot` tool tell the model those names are not chats. `message_bot` refuses a Hub roster row and does not start a run.

`POST /rpc/hub/outbox` lists pending rows for the signed-in space. `POST /rpc/hub/ackOutbound` with `{ "deliveryIds": ["..."] }` marks those ids `done`. An optional `meshId` on that call is stored on the rows it acks. Ids outside the caller's space stay untouched.

## Hub skill to Rakazo

Hub → Rakazo stays `threads/receiveHub`. A Hub skill named `message_rakazo_bot` (not a Rakazo builtin) can resolve `rakazoBots` from `hub/directory` and post `{ botId, hubAgentId, hubAgentName, text }`, or post `{ groupId, hubAgentId, hubAgentName, text }` for a ChatGroup. Either payload may include `spaceTopicKey`. This repository does not ship that Hub-side skill.

How a Hub member picks a ChatGroup in the Hub client is residual. Grok App is closed source, and this repository has no Hub UI for that choice. The API accepts `groupId`. The client that offers it is not here.

A flash-lite turn can still die before any tool with `Provider finish_reason: error`. That string is Pi mapping an upstream `finish_reason` of `error` (`@earendil-works/pi-ai` `mapStopReason`), not a missing group route. The same string aborted a bot DM before the group sends. It is not `content_filter`. Per-bot flash-lite, the space default, and `PI_DEFAULT_MODEL` stay as they are. `hub_send_message` from a group run does not depend on that provider: the tool inserts the outbox row when the run actually calls it.
