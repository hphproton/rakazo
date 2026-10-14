# Seal the computer preview and the overlay separately

## Title

Seal the computer preview and the overlay separately

## Body

### Why

While the user holds this bot's control lease, `computer/screenUrl` always returned a control seal. The preview and the full window stored that one URL. Opening the window and later returning to the preview both connected a control socket, so the view-only card could take the interactive stream the overlay was using.

### What

`screenUrl` takes an optional `interactive` flag. `interactive: false` seals a view token and does not pass the control token. Omitting the flag keeps the lease rule: control only while this bot's lease is held. `interactive: true` without a live lease is still a view seal.

`computerScreenUrlInput` sends `{ botId, interactive: false }` for the preview and `{ botId }` for the overlay. Web and mobile keep the two URLs in separate state. The card unmounts while the window is open. Opening sets the overlay flag before the refresh that fills the window, and closing clears it before the refresh that refills the card, so each response is stored on the surface that asked for it.

### How tested

`computer screen url > seals a view token for the preview and a control token for the overlay` failed before the change: with a held lease the preview pathname contained `/novnc/session/control/`. After the change, the preview is `/novnc/session/view/` with `target.interactive` false, the overlay is `/novnc/session/control/` with `target.interactive` true, and a request that forces `interactive: true` with no lease stays on `/novnc/session/view/`.

`computer screen > asks the preview for a view seal and the full window for a separate control seal` failed before the change: the preview iframe loaded the control URL because every `computer/screenUrl` call omitted `interactive`. After the change, card calls send `interactive: false` and load the view URL, opening the window sends `{ botId }` only and loads the control URL, and closing sends `interactive: false` again.

Also covered by `asks the preview for a view seal and the overlay for control`, `issues lifecycle-bound capabilities for managed-provider screens too`, and `opens a terminal only for the user holding this bot's control lease`.

PR CI: `pnpm lint` (including the translation-catalog check), `pnpm check`, `pnpm build` with the Electron preload smoke, `pnpm test`, `pnpm test:integration`, and `pnpm test:e2e`.
