# Terminal Plugin Doctrine

`runtime/fleet-plugins/terminal` owns the built-in Fleet Console Terminal plugin.

## Settings Ownership

- The Terminal plugin owns `/plugins/terminal/settings`.
- `GET /plugins/terminal/settings` returns the Terminal prompt settings DTO. Loopback host validation is enforced by the upstream console host gate before plugin route dispatch.
- `PUT /plugins/terminal/settings` requires the terminal Origin authorization gate and updates only Terminal prompt settings.
- The Terminal plugin owns one Settings section: `Agent CLI`.
- The `Agent CLI` Settings section renders exactly four blocks in order: System Prompt, Agent CLI Available, Terminal Font, and Terminal Renderer.
- `Agent CLI` owns `enableMetaphor` UI controls for Terminal-launched agent sessions.
- Prompt settings persist through `@dotobokuri/core-infra` data-dir/settings in `~/.fleet/settings.json`. Do not move these settings into plugin storage.
- Terminal Font and Terminal Renderer settings are Terminal plugin-owned end-to-end: state, persistence, UI, and consumption all live in the plugin. Core/client must not touch these values.
- **Terminal Font** (name + size) is persisted on the console server under `plugins.terminal.font` via `ClientSettingsCapability` (`/api/v1/settings/plugins/terminal`). This survives browser changes and console restarts. **Terminal Renderer** remains in localStorage under `fleet-plugin.terminal.renderer` — do not move it to server storage.
- Terminal Font UI is the controlled `@fleet-console/font-picker/browser` package with its explicit stylesheet. It fetches the host-owned, same-origin `GET /api/v1/settings/fonts/system` catalog through the shared validator and passes only host-classified `monospace === true` records; route failure remains Built-in-only with no free-text fallback. Installed selections retain the backward-compatible `{ source: "custom", customName }` payload through `setInstalledTerminalFont`, so external-plugin shims and the Terminal settings schema remain unchanged.
- On first load the store attempts to hydrate font from the server. If the server has no value but `fleet-plugin.terminal.font` exists in localStorage, the local value is seeded to the server via a single PUT and the localStorage key is deleted (1-time migration, idempotent — if the server already has a value on any subsequent load, the local key is deleted without re-seeding). Legacy keys (`fleet-console.terminalRenderer`, `fleet-console.terminalFont`) are migrated once on first access to the new namespace keys before server hydration.
- **Hydration race guard**: if the user calls `setTerminalFont*`/`setTerminalFontSize` while a server `read` is still pending, the `fontWriteEpoch` counter is bumped and the hydration result is discarded on resolve — the user's explicit write always wins.
- All prefs state is module-scoped in `client/shared/terminal-prefs-store.ts` and subscribed via `useSyncExternalStore`. Every mounted terminal panel (active, inactive, dormant) reacts instantly to settings card changes.

## Global Shell Ownership

- The Terminal plugin owns the right-rail Global Shell panel (`client/global-shell/rail-panel.tsx`) and the singleton ticket route `/plugins/terminal/global/ticket` (`server/global.ts`).
- Global Shell is Theater-independent: the rail panel ignores `RailPanelContext.theaterId`, uses the fixed session id `global-shell`, and reuses `/plugins/terminal/ws`.
- Global Shell tickets use `cwd: os.homedir()` and must not call `ctx.host.operations.get()` or `ctx.host.paths.resolveTheaterPath()`.
- Because the fixed session id and fixed `$HOME` cwd let any caller open the home shell with no prior knowledge, the ticket route additionally rejects requests without an `Origin` header (browser-only surface); do not relax this below the upstream terminal authorization gate.
- Do not add stale-session cleanup (empty-write probing then terminate) in the ticket route. The session manager self-removes PTYs on exit via `onExit`; probing risks killing a live session on a transient write error.
- Rail collapse/reopen relies on server scrollback replay. Do not add client-side session destruction for the Global Shell panel.

## Symbols Nerd Font Fallback

- The Terminal plugin vendors `Symbols Nerd Font Mono` under `client/assets/fonts/` and imports its `@font-face` from plugin client code. Do not move this into fleet-console core.
- Every curated and custom terminal font chain must keep `"Symbols Nerd Font Mono"` immediately before the final `monospace` fallback.
- WebGL glyph atlas caching makes preload order part of the contract: fire `preloadSymbolsNerdFontMono()` during plugin install and await `waitForSymbolsNerdFontMono()` before `terminal.open()`.
- Do not call `WebglAddon.clearTextureAtlas()` to recover font glyphs; the atlas is shared across terminals and must remain untouched.
