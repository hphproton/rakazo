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

Hub → Rakazo uses `POST /rpc/threads/receiveHub`. That stores a peer receipt and wakes the target bot with trigger `hub_message`.

```json
{
  "json": {
    "botId": "<target bot id>",
    "hubAgentId": "hub-atlas",
    "hubAgentName": "Atlas",
    "text": "Deploy the staging build."
  }
}
```

`threads/send` remains a person typing. A bot webhook whose JSON has `origin` `hub`, `event` `hub_message`, or both `hubAgentId` and `hubAgentName` responds `409` with `Hub inbound uses threads/receiveHub` and does not store a user message. Other webhook bodies are unchanged.

## Rakazo to Hub

A Rakazo bot delivers with the builtin tool `hub_send_message`. The user does not type `TO_HUB:`. Writing `TO_HUB:` in a reply does not send. The tool resolves a Hub member from the same directory rows as `hub/directory` (`spawnKey` `hub:<hubAgentId>`), by explicit id or by name and title. It does not require `hub/syncMembers` or a visible Hub sidebar section.

The tool writes a `HUB-INBOX` row with status `wake` and a `hub_message_sent` message in the sending bot's thread. That row is a Hub chip in the same family as an inbound receipt (`Message from Hub · {name}`): avatar, pill, left alignment, and no payload bubble in the bot thread. The label is `To Hub · {name}`. When one topic includes more than one Hub member, the thread collapses each direction that has more than one turn into a single chip. The sends share `To Hub · Box Principal, OSS Local Lab`. The replies share `Message from Hub · Box Principal, OSS Local Lab`. A topic with one member still shows `To Hub · {name}` and `Message from Hub · {name}` as separate chips. The stored blocks stay; this only changes which chips the thread draws. Either chip opens the view-only topic that contains that chip. A topic is one stretch on one bot thread. Several `hub_send_message` calls before the bot writes a reply share it, and so do inbound receipts from those members. A burst of receipts from several Hub agents, with no bot reply between them, is the same kind of topic. The header lists every member (`{bot} · Hub · Box Principal, OSS Local Lab`). Each turn names its speaker. An outbound in that topic is `{bot} · Hub · {name}` so the sends stay distinct. A topic with one member keeps the 1:1 labels.

A person message — a user row that is not itself a Hub or teammate receipt — ends every open topic on that thread. For a single member, a bot text reply still starts a new topic when the next Hub turn repeats a direction already present, or the topic already has both directions. The missing direction still joins after that reply, so an inbound receipt and the outbound that answers it stay one transcript. A different Hub member who starts only after that reply gets their own topic, so two 1:1s in a row stay apart. An older chip does not open a later topic. If the clicked message is not in the loaded thread, the view stays empty and does not substitute the latest topic. The stored blocks have no Hub topic id, and `threadKey` on the outbox row is not copied onto the echo. The person does not type in the transcript. Delivery stays this tool, then the outbox, then the mesh. The outbox row is the first-party drain. This tip has no separate native outbound sender, so cutover still reports `rakazoToHub` `mcp`: a host-straight mesh reads the outbox instead of scraping a `TO_HUB:` user message.

The transcript is not a Hub seat. Directory rows stay out of the sidebar, search, and `message_bot`. Web loads that bot's thread (`threads/messages` with peer runs) and selects the topic for the clicked message. Mobile does the same from either Hub chip. A second Rakazo bot's thread is a separate transcript even when both message the same `hubAgentId`. There is still no space-wide Hub inbox, no live update while the view is open, and no composer.

## Lab smoke: multi-party topic

One Rakazo bot. Two Hub members, for example Box Principal and OSS Local Lab.

1. Send a person message on that bot asking both.
2. In the same turn, before the bot writes a reply, call `hub_send_message` once for Box Principal and once for OSS Local Lab.
3. Deliver each reply with `threads/receiveHub` on that same bot, before the next person message.
4. The thread shows two chips for that burst, not one per leg: `To Hub · Box Principal, OSS Local Lab` and `Message from Hub · Box Principal, OSS Local Lab`. Open either.

The view is one topic. Both chips open it. Both sends and both replies are interleaved. The header reads `{bot} · Hub · Box Principal, OSS Local Lab`. Each reply shows its Hub name. The footer stays `This chat is view-only`. There is no composer. Hub members stay out of the sidebar.

A chip from a 1:1 that the person message already closed still opens only that 1:1. A Hub member addressed only after the bot has replied stays on their own topic.

The Hub directory prompt and the `message_bot` tool tell the model those names are not chats. `message_bot` refuses a Hub roster row and does not start a run.

`POST /rpc/hub/outbox` lists pending rows for the signed-in space. `POST /rpc/hub/ackOutbound` with `{ "deliveryIds": ["..."] }` marks those ids `done`. An optional `meshId` on that call is stored on the rows it acks. Ids outside the caller's space stay untouched.

## Hub skill to Rakazo

Hub → Rakazo stays `threads/receiveHub`. A Hub skill named `message_rakazo_bot` (not a Rakazo builtin) can resolve `rakazoBots` from `hub/directory` and post `{ botId, hubAgentId, hubAgentName, text }`. This repository does not ship that Hub-side skill.
