# Seal the computer preview and the overlay separately

## Title

Seal the computer preview and the overlay separately

## Body

### Why

While the user holds this bot's control lease, `computer/screenUrl` always returned a control seal. The preview and the full window stored that one URL. Opening the window and later returning to the preview both connected a control socket, so the view-only card could take the interactive stream the overlay was using.

### Repro

Take control of a running computer, then open it. The card request and the overlay request both come back as `/novnc/session/control/...`. Closing the window leaves the card on that control seal.

### Fix

`screenUrl` takes an optional `interactive` flag. `interactive: false` seals a view token and does not pass the control token. Omitting the flag keeps the lease rule: control only while this bot's lease is held. `interactive: true` without a live lease is still a view seal.

`computerScreenUrlInput` sends `{ botId, interactive: false }` for the preview and `{ botId }` for the overlay. Web and mobile keep the two URLs in separate state. The card unmounts while the window is open. Opening sets the overlay flag before the refresh that fills the window, and closing clears it before the refresh that refills the card, so each response is stored on the surface that asked for it.

### Tests

- `asks the preview for a view seal and the overlay for control`
- `seals a view token for the preview and a control token for the overlay`
- `asks the preview for a view seal and the full window for a separate control seal`
- `issues lifecycle-bound capabilities for managed-provider screens too`
- `opens a terminal only for the user holding this bot's control lease`

## Evidence

Test `computer screen url > seals a view token for the preview and a control token for the overlay`, with a held lease.

Before: the preview pathname contained `/novnc/session/control/`. A held lease always sealed control, so the assertion that the preview contains `/novnc/session/view/` failed. The preview and overlay pathnames were the same.

After: the preview is `/novnc/session/view/` with `target.interactive` false, the overlay is `/novnc/session/control/` with `target.interactive` true, and the pathnames differ. A request that forces `interactive: true` with no lease stays on `/novnc/session/view/`.

Test `computer screen > asks the preview for a view seal and the full window for a separate control seal`, with the user already holding control.

Before: the preview iframe loaded the control URL. Every `computer/screenUrl` call omitted `interactive`, so the server returned the control seal for the card as well. The assertion that the preview loads the view URL failed.

After: every card call sends `interactive: false` and the preview iframe loads the view URL. Opening the window sends `{ botId }` only, the one visible iframe loads the control URL, and closing sends `interactive: false` again so the card iframe is back on the view URL. The other computer-screen cases still pass.

`computerScreenUrlInput` returns the card and overlay payloads above. Typecheck passed for contracts, API, web, and mobile. Biome passed on the touched files.
