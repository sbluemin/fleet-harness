# Fleet Console Desktop Doctrine

`runtime/fleet-console-desktop` is the optional, thin Electron main-process shell for Fleet Console. It owns one native app lifecycle, one `BrowserWindow`, tray/menu/dialog update UX, packaged resource discovery, and supervision of the separately packaged standard Node sidecar.

## Hard boundary

- `runtime/fleet-console` remains the sole owner of HTTP/REST/SSE/WebSocket, `node-pty`, provider launch policy, trusted plugins, durable JSON state, lock files, and the React/Vite UI.
- Desktop loads only the authenticated-and-verified loopback origin's token-free `/console/` route. Do not add a renderer fork, preload bridge, raw IPC surface, local HTML fallback, HTTP server, PTY/session manager, provider adapter, plugin registry, or durable-state implementation here.
- Electron may consume only the public `@dotobokuri/fleet-console/desktop-protocol` leaf for owner/protocol/resource validation; never import Console internals.

## Runtime contract

- The sidecar is standard Node `22.23.1`, staged outside asar at `resources/sidecar/{node,fleet-console}` for packaged builds.
- Desktop, published CLI, and browser share the canonical stable lock and `~/.fleet/console` data namespace. `FLEET_CONSOLE_DIR` remains the explicit operator/test override.
- Adopt only a healthy matching desktop owner id, protocol version, and app/service version. Do not signal a CLI-owned daemon without explicit operator confirmation. CLI `stop`/`restart` must not kill a desktop owner.
- A second app instance focuses the first. Closing the only window keeps macOS alive and hides to tray on Windows/Linux; native Quit stops only the verified desktop-owned sidecar. A later matching app may adopt a sidecar after an Electron crash.

## Package and release

- Use `pnpm --filter @dotobokuri/fleet-console-desktop build`, `stage:sidecar`, `verify:sidecar`, `package:dir`, `package`, and `verify:package` only as declared in `package.json`; staging, packaging, signing, and publishing are opt-in.
- Supported artifact targets are macOS arm64/x64 DMG/ZIP, Windows x64 NSIS, and Linux x64 AppImage. Do not claim a platform signature without release evidence. macOS release signing/notarization and Windows Authenticode require protected credentials; Linux integrity uses release checksum/GPG material when available.
- Desktop updates are native Electron updates from signed GitHub Release metadata. It never uses the npm updater or a renderer update API.
