# Single-space bridge

Use this when one deployment should stay one operator, one default space, and one external bridge. Better Auth, organizations, and spaces stay as they are. This page does not add a personal access token, a service-account table, or another sign-in method.

Two stock credentials cover the bridge. They are not interchangeable.

| Need | Credential | What it can do |
| --- | --- | --- |
| Deliver one event into one bot's thread | That bot's webhook secret | `POST /api/v1/bots/<botId>/webhook` only |
| Call authenticated RPC (confirm the space, close signups, create the bot, rotate the webhook secret) | The operator's session, sent as a bearer token | Everything that account can do, including deployment settings when it is the owner |

Prefer the webhook secret for ordinary inbound. Use the session only for the operator actions that mint and lock the deployment. A session is not a narrow key.

## The single space

The first admitted human signup becomes the deployment owner and receives one personal organization and one default space. The space is named Personal, `isDefault` is true, and its id is the organization id. The default space cannot be deleted.

That default space is the bridge space.

- Do not create more spaces. `POST /rpc/spaces/create` still works; this deployment simply does not use it.
- Do not call `/api/auth/organization/*`. Those routes stay closed (`Not available in version 1`). Space lifecycle stays on the product RPCs.
- Authenticated RPC resolves membership in `requireMembership`. With no `x-rakazo-space-id` header, the order is default space first, then oldest membership. With one membership, omit the header.
- If the header is sent, set it to that default space id. Read it from `POST /rpc/me` (`spaceId`) or from the entry with `isDefault: true` in `POST /rpc/spaces/list` (`spaces`).
- If `spaces` has more than one entry, point the bridge only at the default. Do not send another space id.

`POST /rpc/me` is the check. `isDeploymentOwner` is true for the operator account, and `spaceId` is the default space.

## Signup lock

Registration policy is the stored `deployment_settings` row (`id` `default`): `signupsEnabled`, `signupAllowlist`, and `signupPolicyInitialized`. Auth reads that row once it has been initialized. There is no separate switch in the web UI; the owner sets it with `deployment/update`.

Before the API's first start:

```env
SIGNUPS_ENABLED=true
SIGNUP_ALLOWLIST=owner@example.com
```

- `SIGNUPS_ENABLED` is copied into the row once. After `signupPolicyInitialized` is true, changing the variable does not open or close registration. `false` and `0` are the only closed values, and only for that first seed. Leave the variable `true` so the owner can register, then close registration in the stored row.
- A non-empty `SIGNUP_ALLOWLIST` replaces the stored list on every API start. A blank or unset value does not clear a stored list. Entries are comma-separated emails or `@domain` suffixes, matched case-insensitively.
- An empty allowlist does not restrict who may register while signups are open.

After the owner account exists, close registration. Only the deployment owner can call this. Sign-in for the existing account still works. A later signup receives `Registration is closed`.

```bash
curl -sS -X POST "$ORIGIN/rpc/deployment/update" \
  -H "content-type: application/json" \
  -H "origin: $WEB_ORIGIN" \
  -H "authorization: Bearer $SESSION_TOKEN" \
  -d '{"json":{"signupsEnabled":false}}'
```

`$ORIGIN` is `WEB_ORIGIN` when that host proxies `/api` and `/rpc` (the published-images and production layouts). On a source checkout, use the same web origin; it proxies those paths. `$WEB_ORIGIN` is the value from the environment. Do not send a session cookie on this request. If a cookie is present, the bearer is ignored.

`signupsEnabled: false` is stored. A later API start does not turn it back on just because `SIGNUPS_ENABLED=true` is still in the environment. Keep `SIGNUP_ALLOWLIST` set to the operator email so a restart keeps that list. `deployment/update` leaves the stored allowlist unchanged when `signupAllowlist` is omitted. Including `signupAllowlist` replaces it, and an empty array clears it, until the next API start reapplies a non-empty `SIGNUP_ALLOWLIST`.

With a nonempty allowlist and SMTP configured, sign-in requires a verified email. On a fresh instance with no SMTP, the first allowlisted account can register without verification. Create that account before exposing the service. Details are in the [self-hosting guide](./self-host.md).

## Session bearer

This is the Better Auth session issued at sign-in, the same credential the browser cookie and the mobile app use. `Authorization: Bearer` is the stock non-cookie form. It is not a scoped API key. It expires and refreshes with that session. Password reset revokes sessions.

Obtain it once, from the sign-in response. `GET /api/auth/get-session` redacts the token and will not show it again.

```bash
curl -sS -X POST "$ORIGIN/api/auth/sign-in/email" \
  -H "content-type: application/json" \
  -H "origin: $WEB_ORIGIN" \
  -d '{"email":"owner@example.com","password":"replace-with-password"}'
```

Use the JSON `token` string. Store it outside the repo and outside logs. Then:

```bash
curl -sS -X POST "$ORIGIN/rpc/me" \
  -H "content-type: application/json" \
  -H "authorization: Bearer $SESSION_TOKEN" \
  -d '{"json":{}}'
```

RPC bodies are `{"json": <input>}`. Auth bodies are the raw JSON object, not wrapped.

Create the bridge bot in the app, or with RPC. `name` is required; the other create fields have defaults.

```bash
curl -sS -X POST "$ORIGIN/rpc/bots/create" \
  -H "content-type: application/json" \
  -H "authorization: Bearer $SESSION_TOKEN" \
  -d '{"json":{"name":"Bridge"}}'
```

Discard the session from the bridge host when those operator steps are done. Do not reuse `BETTER_AUTH_SECRET`, `SANDBOX_SUPERVISOR_TOKEN`, or `RAKAZO_UPDATER_TOKEN` as this token.

## Bot webhook secret

Use this for inbound. It authenticates one bot and writes into that bot's thread. It cannot call `/rpc`. A session token presented here fails with the same 401 as a wrong secret.

Mint it while the session above still works. The plaintext secret is returned once. Rotation replaces it; the previous value stops working. The stored value is encrypted with `ENCRYPTION_KEY`.

In the app, open that bot's routine editor and add **When a webhook fires**. That mints a webhook secret when the bot does not have one yet. After the routine exists, the editor shows the POST URL and `Authorization` header. **Rotate key** issues a new secret and the previous value stops working. The Git event trigger is a different delivery shape on the same stored secret (HMAC on `/api/v1/bots/<botId>/github`). It is not this bridge.

The same mint over RPC, with no routine required:

```bash
curl -sS -X POST "$ORIGIN/rpc/bots/rotateWebhookSecret" \
  -H "content-type: application/json" \
  -H "authorization: Bearer $SESSION_TOKEN" \
  -d '{"json":{"botId":"'"$BOT_ID"'"}}'
```

The response is `{ "secret", "path", "webhookConfigured": true }`. `path` is `/api/v1/bots/<botId>/webhook`.

```bash
curl -sS -X POST "$ORIGIN/api/v1/bots/$BOT_ID/webhook" \
  -H "content-type: application/json" \
  -H "authorization: Bearer $WEBHOOK_SECRET" \
  -H "idempotency-key: example-event-1" \
  -d '{"event":"bridge.ping","text":"hello"}'
```

- The header is the word `Bearer`, one space, then the secret.
- JSON body, at most 64 KiB. A larger body is rejected before the bot is looked up.
- Optional idempotency: `Idempotency-Key`, `X-Idempotency-Key`, or a string `id` / `event_id` in the JSON.
- Missing bot, missing secret, and wrong secret all return `401` `{"error":"Unauthorized"}`.
- Success returns `{"ok":true,"messageId","runId","seq"}`. `runId` is null when no run was started. The payload is untrusted delivery data. It wakes that bot. If that bot has webhook-enabled routines, up to five of them (the most recently updated) are included in the prompt.
- This delivery stays an inbound user message on that bot's thread. It does not set a separate speaker identity.

Reusable bot credentials (`request_secret` / `bot_secrets`, documented in [Bot secrets](./bot-secrets.md)) are a different store. Do not put the webhook secret there, and do not put either value in `.env` or git.

## Out of scope

This convention does not remove or bypass Better Auth, organizations, or spaces. It does not change message identity, import or export a roster, or add a discovery document. It does not change sandbox providers, Compose files, or network tunnels, and it does not embed Rakazo in another application's sidebar.
