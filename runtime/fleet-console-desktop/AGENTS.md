# Fleet Console Desktop Doctrine

`runtime/fleet-console-desktop` is the optional thin Electron shell for Fleet Console. It owns one native app lifecycle, one `BrowserWindow`, native menu/tray/dialog surfaces, the passive entry page, and supervision of the desktop-managed Console runtime.

## Hard boundary

- `runtime/fleet-console` remains the sole owner of HTTP/REST/SSE/WebSocket, `node-pty`, provider launch policy, trusted plugins, durable JSON state, lock files, and the React/Vite UI.
- Desktop loads only the authenticated-and-verified loopback origin's token-free `/console/` route. Do not add a renderer fork, raw IPC surface, HTTP server, PTY/session manager, provider adapter, plugin registry, or durable-state implementation here.
- The one allowed local renderer surface is `assets/entry/`: a scriptless, view-only status page. Main process code may push full snapshots one way through `webContents.executeJavaScript`; preload, `ipcMain`, `ipcRenderer`, `contextBridge`, and renderer input remain forbidden. Native dialogs are the only input surface.
- Electron may consume only the public `@dotobokuri/fleet-console/desktop-protocol` leaf for owner/protocol/resource validation; never import Console internals.

## Runtime and lifecycle contract

- Packaged Desktop provisions code under `~/.fleet/desktop/runtime/node` and `~/.fleet/desktop/runtime/console/latest`. Installation uses temporary `console/.staging-*`; a replacement may use `latest.rollback` only during its rename transaction. Steady state contains one `latest` installation.
- `~/.fleet/console` remains the Console data namespace for state, captures, and locks. `FLEET_CONSOLE_DIR` is the explicit operator/test override. Never conflate the removable Desktop runtime with Console data.
- J1 first launch bootstraps managed Node and installs the latest Console. J2 confirms the current version then starts. J3 installs a newly found version before handoff. J4 uses valid installed `latest` when registry access fails. J5 adopts a healthy matching desktop-owned Console without procurement. J6 polls every 60 minutes and on manual Check, then offers native update action plus menu/tray fallback. J-dev uses workspace `dist`, `FLEET_CONSOLE_NODE_PATH`/`npm_node_execpath`, and the local channel; it bypasses the managed runtime and update check.
- Entry states are passive `daily`, `update`, `firstrun`, `offline`, `firstfail`, and `longrun`, plus J-dev. Completion hands off the same window to `/console/`; it never creates a second renderer surface.
- A second app instance focuses the first. Closing the only window keeps macOS alive and hides to tray on Windows/Linux. Native Quit stops only the verified desktop-owned Console. A later matching app may adopt a sidecar after an Electron crash.

## Updates and packaging

- Desktop checks the npm registry at launch and by a 60-minute/manual poll. A found version is installed only after `app.relaunch()` returns through the entry flow; do not implement in-place replacement. Native `[Update and Restart]`/`[Later]` with `Skip this version` is prompted at most once per version; menu/tray retain `Update to x.x.x...` as the pull fallback.
- `package:dir` is credential-free local verification. `package:unsigned` produces unsigned artifacts. `package:release` is the protected signing/notarization path and must fail closed without its required credentials. Run `verify:package` for the shell-only ASAR/fuse/asset check.
- The build copies entry HTML/CSS, the pinned Node manifest, and the icon into `dist`. Packaged artifacts contain no Console or Node payload, legacy embedded runtime directory, updater metadata, or standalone blockmap.
- Supported release targets are macOS arm64/x64 DMG/ZIP, Windows x64 NSIS, and Linux x64 AppImage. Do not claim platform signing without release evidence. Windows native packaging and live verification are [Unverified] on non-Windows hosts.
