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

The tool writes a `HUB-INBOX` row with status `wake` and a `hub_message_sent` message in the sending bot's thread. That thread message shows the outbound text and a Hub destination marker. It does not open a chat with the Hub member. The outbox row is the first-party drain. This tip has no separate native outbound sender, so cutover still reports `rakazoToHub` `mcp`: a host-straight mesh reads the outbox instead of scraping a `TO_HUB:` user message.

The Hub directory prompt and the `message_bot` tool tell the model those names are not chats. `message_bot` refuses a Hub roster row and does not start a run.

`POST /rpc/hub/outbox` lists pending rows for the signed-in space. `POST /rpc/hub/ackOutbound` with `{ "deliveryIds": ["..."] }` marks those ids `done`. An optional `meshId` on that call is stored on the rows it acks. Ids outside the caller's space stay untouched.

## Hub skill to Rakazo

Hub → Rakazo stays `threads/receiveHub`. A Hub skill named `message_rakazo_bot` (not a Rakazo builtin) can resolve `rakazoBots` from `hub/directory` and post `{ botId, hubAgentId, hubAgentName, text }`. This repository does not ship that Hub-side skill.
