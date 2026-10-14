# Return sealed screen URLs as viewer-relative paths

## Title

Return sealed screen URLs as viewer-relative paths

## Body

### Why

A sealed screen URL was an absolute address on the configured web origin, often `http://127.0.0.1:5173`. Opening the app through another host on that same port, such as a tailnet address or a reverse proxy, made the browser load the page and its websocket from that configured origin. The picture stayed black.

### What

`sealScreenCapability` returns a path and query (`/novnc/session/.../vnc.html?...`). The `path` query is the relative sibling `websockify`, and `host` is not set.

Stock noVNC 1.7 leaves `host` unset and resolves `path` with `new URL(path, location.href)`, so the socket stays in the capability directory on the page's origin. The shipped embed joins that same relative path onto the capability directory. A capability prefix without a leading slash would nest under the page, so the socket path is `websockify` and not the session prefix.

This is the opposite shape from upstream #1333. That change set an origin-absolute websocket path (`/novnc/session/.../websockify`) so a document-relative join would not repeat the capability directory, and it kept the sealed document itself absolute on the configured origin. The absolute socket path is right only when that document is already loaded from the viewer's origin. Putting the origin in the seal sends a proxied viewer back to the configured host. A relative document plus the sibling `websockify` stays on the page origin for both resolvers, and still does not repeat the prefix. Setting `host` would make stock open `/websockify` at the host root, so `host` stays unset.

The ciphertext, policy, generation checks, and remote-seal reuse are unchanged. The configured origin is still only a reuse key.

The web app already resolves a screen URL against `window.location`. Mobile WebViews need an absolute URI, so `embeddableScreenUrl` resolves a `/novnc/` seal with `new URL(url, apiBase)`. An absolute loopback provider URL still keeps its port and takes a non-loopback API host. `desktop://` URLs stay unsealed.

### How tested

`sealed screen capabilities > viewer <host> connects a seal of <upstream> on its own origin` failed before the change: the seal did not start with `/novnc/session/` and was an absolute URL on the configured origin. After the change, a tailnet viewer and a loopback viewer each seal a remote `vnc.html` and a loopback `embed.html` as a path and query with `path=websockify` and no `host`. Stock noVNC 1.7 and the shipped embed both resolve that sibling to `/novnc/session/.../websockify` on the viewer's own host, and opening that path still returns the sealed provider socket without the provider token.

Also covered by `keeps noVNC routing public and nested provider socket credentials sealed`, `resolves a relative seal against the page that embedded it`, `resolves a relative seal against the API origin`, `issues lifecycle-bound capabilities for managed-provider screens too`, and `opens a terminal only for the user holding this bot's control lease`.

PR CI: `pnpm lint` (including the translation-catalog check), `pnpm check`, `pnpm build` with the Electron preload smoke, `pnpm test`, `pnpm test:integration`, and `pnpm test:e2e`.
