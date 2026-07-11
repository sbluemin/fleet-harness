# Fleet Console Desktop

Fleet Console Desktop is the optional Electron native shell for Fleet Console. It does not contain another renderer or Console server. Electron supervises the separately packaged standard Node `22.23.1` Console Service, waits for token-authenticated loopback health, and loads exactly `http://127.0.0.1:<verified-port>/console/` in a sandboxed window.

## Ownership and coexistence

`runtime/fleet-console` remains the sole owner of HTTP/REST/SSE/WebSocket, `node-pty`, provider launch policy, trusted plugins, durable JSON state, lock state, and the React UI. The Desktop shell owns native lifecycle, menu/tray/dialog surfaces, secure window policy, and sidecar supervision only.

Desktop, published `fleet-console`, and `fleet console` use the same canonical stable lock and `~/.fleet/console` durable-data namespace. `FLEET_CONSOLE_DIR` is the explicit operator/test override. The owner/protocol/version checks prevent a second writer: a compatible desktop sidecar can be adopted after an unexpected Electron crash, while a healthy CLI-owned daemon is never terminated without explicit confirmation. `fleet console` can attach/open a compatible desktop endpoint; CLI `stop` and `restart` refuse a desktop owner and direct the operator to native **Quit**.

Closing the only window follows normal macOS app behavior and hides to tray on Windows/Linux. A second launch restores the existing window. Native **Quit**, OS shutdown, and update installation stop only the verified desktop-owned sidecar.

## Development and packaging

From the repository root, use the declared package commands:

```bash
pnpm --filter @dotobokuri/fleet-console-desktop typecheck
pnpm --filter @dotobokuri/fleet-console-desktop build
pnpm --filter @dotobokuri/fleet-console-desktop test
pnpm --filter @dotobokuri/fleet-console-desktop stage:sidecar
pnpm --filter @dotobokuri/fleet-console-desktop verify:sidecar
pnpm --filter @dotobokuri/fleet-console-desktop package:dir
pnpm --filter @dotobokuri/fleet-console-desktop verify:package
```

`stage:sidecar` obtains the checksum-pinned Node `22.23.1` runtime and stages the Console Service outside asar. `package:dir` makes an unsigned directory package for local verification. `package` is the release path and fails closed when the required release signing identity is unavailable. Desktop logs are written under Electron user data as `desktop.log`; Console logs, cache, state, captures, and the canonical lock/data locations remain Console Service concerns.

## Install, update, and limits

Release targets are separate macOS arm64 and x64 DMG/ZIP artifacts, Windows x64 NSIS, and Linux x64 AppImage. Install the artifact for the host architecture from the Fleet Console GitHub Release. Other architectures and package stores are not v1 targets.

The stable browser/CLI channel uses the existing npm-global updater. Desktop does not query npm or expose the browser update API: use the native **Check for Updates** and **Update and Restart** commands, which consume GitHub Release update metadata. Release publication remains draft until the required target build, verification, and signing gates pass. macOS Developer ID/notarization, Windows Authenticode, and Linux GPG/checksum evidence depend on protected release credentials; an unsigned local package is not a signed release claim.

## Troubleshooting

- **CLI daemon already running:** choose Retry or Quit, or explicitly confirm the CLI-to-Desktop switch. Do not delete a healthy lock.
- **Stale lock after a crash:** relaunch Desktop first; it can adopt a matching healthy sidecar and removes only a proven-dead stale lock.
- **Native module or esbuild error:** rerun `stage:sidecar` and `verify:sidecar`; the sidecar must use its staged standard Node, not system Node or writable app resources.
- **Provider not found:** start the app from an environment where the provider CLI is on `PATH`; Desktop sanitizes inherited Electron/Node options but does not implement provider discovery.
